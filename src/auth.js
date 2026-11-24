// JWT access (15 min) + revocable opaque refresh tokens (7 days).
// POST /api/auth/login-phone is a phone-only fallback authorized by the
// owner on 24 Nov 2026 while Meta WhatsApp OTP is blocked — see routes.js.
// Phone alone is never accepted as an Authorization credential: every
// protected route still requires a valid JWT issued by OTP verify or by
// the phone-only login endpoint.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('./config');
const { store, sha256 } = require('./store');

function issueTokens(user) {
  // user: { phone, role, providerId? }
  const access = jwt.sign(
    { sub: user.phone, role: user.role, providerId: user.providerId || null },
    config.jwtSecret,
    { expiresIn: config.jwtAccessTtl }
  );
  const refreshId = crypto.randomUUID();
  const refreshPlain = crypto.randomBytes(32).toString('hex');
  store.data.refreshTokens[refreshId] = {
    id: refreshId,
    phone: user.phone,
    role: user.role,
    providerId: user.providerId || null,
    hash: sha256(refreshPlain),
    expiresAt: new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000).toISOString(),
    revoked: false,
    createdAt: new Date().toISOString(),
  };
  store.save();
  return { accessToken: access, refreshToken: `${refreshId}.${refreshPlain}`, expiresInSeconds: 15 * 60 };
}

function verifyRefreshToken(token) {
  if (typeof token !== 'string') return null;
  const [id, plain] = token.split('.');
  if (!id || !plain) return null;
  const rec = store.data.refreshTokens[id];
  if (!rec || rec.revoked) return null;
  if (new Date(rec.expiresAt).getTime() < Date.now()) return null;
  if (rec.hash !== sha256(plain)) return null;
  return rec;
}

function revokeRefreshToken(token) {
  const rec = verifyRefreshToken(token);
  if (rec) {
    rec.revoked = true;
    store.save();
    return true;
  }
  return false;
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid Authorization header. Phone alone is never accepted.' });
  try {
    const payload = jwt.verify(m[1], config.jwtSecret);
    req.user = { phone: payload.sub, role: payload.role, providerId: payload.providerId || null };
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: `Requires role: ${roles.join(' or ')}` });
    }
    return next();
  };
}

// Admin JWT issued by POST /api/admin/pin/verify (30-min session).
function issueAdminToken() {
  return jwt.sign({ sub: 'admin', role: 'admin' }, config.jwtSecret, { expiresIn: config.adminSessionTtl });
}

module.exports = { issueTokens, verifyRefreshToken, revokeRefreshToken, requireAuth, requireRole, issueAdminToken };
