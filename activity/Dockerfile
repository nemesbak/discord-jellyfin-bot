FROM node:20-slim AS builder
WORKDIR /build
COPY package.json .
RUN npm install
COPY client/ client/
COPY vite.config.js .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev && npm cache clean --force
COPY server/ server/
COPY --from=builder /build/dist ./dist
ENV NODE_ENV=production PORT=3001
USER node
EXPOSE 3001
CMD ["node", "server/index.js"]
