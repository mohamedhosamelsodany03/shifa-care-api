FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# The app runs as USER node and persists state in ./data.json (atomic
# write temp + rename). Files copied by Docker are root-owned by default,
# so the node user could not write data.json and every write path failed
# (500s, and the async OTP handler even crashed the process). Give the
# app directory to node.
RUN chown -R node:node /app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
