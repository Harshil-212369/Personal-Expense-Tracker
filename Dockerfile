# syntax=docker/dockerfile:1

# --- Build the UI -------------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY e2e/package.json e2e/
# --ignore-scripts: the "prepare" hook installs git hooks, which a container has no use for.
RUN npm ci --ignore-scripts
COPY server/src/contracts.ts server/src/contracts.ts
COPY server/src/lib server/src/lib
COPY web web
RUN npm run build -w web

# --- Runtime ------------------------------------------------------------------
# The server runs TypeScript directly (Node strips the types) and uses the
# built-in SQLite module, so the image needs no compiler and no native addons.
FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATABASE_PATH=/data/ledgerlens.db
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --ignore-scripts -w server && npm cache clean --force
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
RUN mkdir /data && chown node:node /data
VOLUME /data
# Never root. Because HOST is 0.0.0.0 the server refuses to start without API_TOKEN.
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.ts"]
