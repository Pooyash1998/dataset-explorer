# Backend image (Render, or anywhere that runs Docker). Build context is the repo root: the server reuses prototype/js/schema.js.
FROM node:22-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
COPY prototype/js/schema.js prototype/js/package.json ./prototype/js/
ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 8787
CMD ["node", "server/src/index.js"]
