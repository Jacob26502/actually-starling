# syntax=docker/dockerfile:1

# better-sqlite3 (a transitive dep of @actual-app/api) is a native addon. This stage was
# originally bun-based (oven/bun:1-slim); that broke — bun's prebuild-install can't resolve
# a matching prebuilt binary for it, falls back to `node-gyp rebuild`, and that fails on a
# slim image with no Python. Plain npm on a Node image resolves a prebuilt binary directly,
# with no compiler needed. See CLAUDE.md ("can't be Bun, for the same underlying reason").
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY config/mapping.example.json ./config/mapping.example.json

# config/mapping.json (your account mapping) and .actual-cache (the downloaded budget)
# are gitignored, per-deployment state — mount them as volumes, don't bake them in.
RUN mkdir -p /app/.actual-cache /app/config && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --env-file-if-exists loads .env if one is bind-mounted, but doesn't error when config
# instead comes from `docker compose`/`docker run -e` env vars, which is the usual path.
CMD ["node", "--env-file-if-exists=.env", "src/index.ts"]
