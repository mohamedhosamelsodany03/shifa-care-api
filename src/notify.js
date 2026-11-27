// In-app notifications + FCM push (primary) + SMS fallback (critical only).
//
// Delivery order per notification (owner decision 26 Nov 2026 — keep the
// cost down):
//   1. In-app notification (always): written to the user's notification
//      list, visible in the #/notifications screen with an unread badge.
//      Free, works whenever the app is opened. This is the record of
//      truth — push/SMS are only delivery attempts for it.
//   2. FCM push (free): sent to every registered device token of the
//      user, when Firebase is configured (FIREBASE_SERVICE_ACCOUNT_JSON
//      or the FIREBASE_* parts) AND the user registered a device via
//      POST /api/me/devices. Push works while the app is closed.
//   3. SMS fallback (0.27 EGP/message, Together SMS) — CRITICAL events
//      ONLY, and only when push could not reach the user:
//        - immediately when there is no registered device, FCM is not
//          configured, or every push send failed, OR
//        - by the sweep, when a critical notification is still UNREAD
//          10 minutes after it was created and still inside its
//          validity window (the user did not see the push).
//      "Unacknowledged" is approximated by the in-app read state —
//      there is no delivery receipt from FCM. SMS is NOT sent for
//      non-critical notifications, and never when the user already read
//      the notification in the app.
//
// Critical events (owner decision): booking accepted, provider en route,
// 1-hour review reminder, Thursday settlement. Everything else is
// non-critical (in-app + push only, never SMS).
//
// FCM registration tokens are stored server-side only and NEVER returned
// by any API. SMS text is Arabic (concise, to stay near one 70-char
// Unicode part where possible).
const config = require('./config');
const { store, newId, nowIso, sha256 } = require('./store');
const { sendPush } = require('./fcm');
const { sendSmsText } = require('./sms');

const SMS_FALLBACK_DELAY_MS = 10 * 60 * 1000; // unread after 10 min -> SMS
const MAX_NOTIFICATIONS_PER_USER = 100;
const MAX_DEVICES_PER_USER = 5;
// v2.1.13 (L1): a device with no successful push in this long is dead
// (app uninstalled / token rotated without an unregister call) — it is
// pruned from every count, so the broadcast tab never counts ghosts.
const DEVICE_INACTIVE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
function deviceIsActive(d, nowMs = Date.now()) {
  const last = d.lastSentAt || d.updatedAt;
  if (!last) return false;
  const t = new Date(last).getTime();
  return Number.isFinite(t) && nowMs - t <= DEVICE_INACTIVE_MS;
}
// Prune dead devices for one phone (in place); returns the live list.
// NOTE: the pruned list is a NEW array (Array.filter always copies), so
// it must be stored back — otherwise callers that mutate the returned
// list (registerDevice pushes into it) write to a detached array and
// the device is lost on the next read (v2.1.13 L1 regression: second
// device stayed at 1, GET /me/devices read back 0).
function pruneDevices(phone) {
  const list = (store.data.devices || {})[phone] || [];
  const live = list.filter((d) => deviceIsActive(d));
  store.data.devices[phone] = live;
  if (live.length !== list.length) store.save();
  return live;
}

// --- device tokens -------------------------------------------------------
function devicesFor(phone) {
  const all = store.data.devices || (store.data.devices = {});
  const list = all[phone] || (all[phone] = []);
  // v2.1.13 (L1): every read prunes dead devices, so counts everywhere
  // (broadcast, dashboard, /me/devices) reflect active devices only.
  return pruneDevices(phone);
}
// Number of ACTIVE devices for one phone (pruned, see devicesFor).
function activeDeviceCount(phone) {
  return devicesFor(phone).length;
}
// Total ACTIVE devices across all phones.
function totalActiveDevices() {
  let n = 0;
  for (const phone of Object.keys(store.data.devices || {})) n += devicesFor(phone).length;
  return n;
}
function registerDevice(phone, token, platform) {
  if (!token || typeof token !== 'string' || token.length < 10 || token.length > 4096) {
    throw new Error('Valid FCM device token required.');
  }
  const list = devicesFor(phone);
  const hash = sha256(token);
  const existing = list.find((d) => d.tokenHash === hash);
  if (existing) {
    existing.updatedAt = nowIso();
    existing.platform = platform || existing.platform || null;
  } else {
    list.push({ token, tokenHash: hash, platform: platform || null, updatedAt: nowIso() });
    while (list.length > MAX_DEVICES_PER_USER) list.shift();
  }
  store.save();
  return list.length;
}
function unregisterDevice(phone, token) {
  const list = devicesFor(phone);
  const hash = sha256(String(token || ''));
  const before = list.length;
  store.data.devices[phone] = list.filter((d) => d.tokenHash !== hash);
  if (store.data.devices[phone].length !== before) store.save();
  return before - store.data.devices[phone].length;
}

// --- notification records -------------------------------------------------
function notificationsFor(phone) {
  const all = store.data.notifications || (store.data.notifications = {});
  return all[phone] || (all[phone] = []);
}
function publicNotification(n) {
  return {
    id: n.id, type: n.type,
    titleAr: n.titleAr, titleEn: n.titleEn,
    bodyAr: n.bodyAr, bodyEn: n.bodyEn,
    data: n.data || {},
    createdAt: n.createdAt, readAt: n.readAt || null,
    pushStatus: n.pushStatus, smsStatus: n.smsStatus,
    critical: !!n.critical,
  };
}

// Create the in-app record, then deliver push, then SMS-fallback when the
// event is critical and push could not reach the user. The record is
// saved BEFORE any network call, so the in-app center always has it even
// if push/SMS fail. Fast and deterministic when nothing is configured
// (no network calls at all) — tests rely on that.
async function notifyUser(phone, opts) {
  const {
    type, titleAr, titleEn, bodyAr, bodyEn, data = {},
    critical = false, validUntilMs = null,
  } = opts || {};
  if (!phone || !type) throw new Error('notifyUser requires phone and type.');
  const list = notificationsFor(phone);
  const rec = {
    id: newId('ntf'), phone, type,
    titleAr: titleAr || 'Shifa Care', titleEn: titleEn || 'Shifa Care',
    bodyAr: bodyAr || '', bodyEn: bodyEn || '',
    data, critical: !!critical,
    createdAt: nowIso(),
    validUntil: validUntilMs ? new Date(validUntilMs).toISOString() : null,
    readAt: null, pushStatus: 'pending', smsStatus: 'not_needed',
  };
  list.push(rec);
  while (list.length > MAX_NOTIFICATIONS_PER_USER) list.shift();
  store.save();

  // --- 2. FCM push -------------------------------------------------------
  const devices = devicesFor(phone);
  if (!config.fcmConfigured()) {
    rec.pushStatus = 'not_configured';
  } else if (devices.length === 0) {
    rec.pushStatus = 'no_device';
  } else {
    let sent = 0;
    const dead = [];
    for (const d of devices) {
      try {
        await sendPush({
          token: d.token,
          title: rec.titleAr,
          body: rec.bodyAr,
          data: { type: rec.type, notificationId: rec.id, ...(rec.data || {}) },
        });
        sent += 1;
        // v2.1.13 (L1): a successful send proves the device is alive.
        d.lastSentAt = nowIso();
      } catch (e) {
        // A dead token (app uninstalled / token rotated) is dropped so
        // later notifications do not keep failing on it.
        if (e && (e.code === 'UNREGISTERED' || e.httpStatus === 404)) dead.push(d.tokenHash);
        console.error(`[notify] push failed phone=${phone} type=${type}: ${e && e.message}`);
      }
    }
    if (dead.length) {
      store.data.devices[phone] = devices.filter((d) => !dead.includes(d.tokenHash));
    }
    rec.pushStatus = sent > 0 ? 'sent' : 'failed';
  }

  // --- 3. SMS fallback (critical only, push did not reach the user) ------
  if (critical && ['failed', 'no_device', 'not_configured'].includes(rec.pushStatus)) {
    await sendSmsFallback(rec);
  }
  store.save();
  return publicNotification(rec);
}

async function sendSmsFallback(rec) {
  if (!config.smsConfigured()) {
    rec.smsStatus = 'not_configured';
    return false;
  }
  const text = rec.bodyAr || rec.bodyEn || '';
  if (!text) { rec.smsStatus = 'failed'; return false; }
  try {
    await sendSmsText({ to: rec.phone, text });
    rec.smsStatus = 'sent';
    return true;
  } catch (e) {
    console.error(`[notify] SMS fallback failed phone=${rec.phone} type=${rec.type}: ${e && e.message}`);
    rec.smsStatus = 'failed';
    return false;
  }
}

// Sweep pass: a critical notification that is still UNREAD 10 minutes
// after creation (and still inside its validity window) gets one SMS
// attempt — the user did not see the push. Called from sweepAutoRelease.
async function processSmsFallbacks() {
  if (!config.smsConfigured()) return { attempted: 0, sent: 0 };
  const now = Date.now();
  let attempted = 0, sent = 0;
  const all = store.data.notifications || {};
  for (const phone of Object.keys(all)) {
    for (const rec of all[phone]) {
      if (!rec.critical || rec.readAt || rec.smsStatus !== 'not_needed') continue;
      if (rec.pushStatus !== 'sent') continue; // immediate-fallback path already handled these
      if (now - new Date(rec.createdAt).getTime() < SMS_FALLBACK_DELAY_MS) continue;
      if (rec.validUntil && now > new Date(rec.validUntil).getTime()) continue; // stale — do not SMS
      attempted += 1;
      if (await sendSmsFallback(rec)) sent += 1;
    }
  }
  if (attempted) store.save();
  return { attempted, sent };
}

function markRead(phone, id) {
  const rec = notificationsFor(phone).find((n) => n.id === id);
  if (!rec) return null;
  if (!rec.readAt) { rec.readAt = nowIso(); store.save(); }
  return publicNotification(rec);
}
function markAllRead(phone) {
  let n = 0;
  for (const rec of notificationsFor(phone)) {
    if (!rec.readAt) { rec.readAt = nowIso(); n += 1; }
  }
  if (n) store.save();
  return n;
}

module.exports = {
  notifyUser, processSmsFallbacks, registerDevice, unregisterDevice,
  devicesFor, activeDeviceCount, totalActiveDevices, deviceIsActive,
  notificationsFor, publicNotification, markRead, markAllRead,
  SMS_FALLBACK_DELAY_MS, DEVICE_INACTIVE_MS,
};
