# ── Stage 1: build frontend ────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /build
COPY package.json .
RUN npm install
COPY client/ client/
COPY vite.config.js .
RUN npm run build

# ── Stage 2: production server ─────────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server/ server/
COPY --from=builder /build/dist ./dist

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
