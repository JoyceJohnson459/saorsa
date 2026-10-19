# Saorsa server: API + AI gateway + built admin web in one image.
FROM oven/bun:1.4.2-alpine AS web
WORKDIR /build
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY admin-web/package.json admin-web/package.json
COPY launcher/package.json launcher/package.json
RUN bun install --frozen-lockfile
COPY admin-web admin-web
RUN cd admin-web && bunx vue-tsc --noEmit && bunx vite build

FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /build
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY admin-web/package.json admin-web/package.json
COPY launcher/package.json launcher/package.json
RUN bun install --frozen-lockfile --production --filter @teamos/server

FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production SAORSA_HOST=0.0.0.0 SAORSA_PORT=8787 SAORSA_ADMIN_WEB_DIST=/app/admin-web/dist
# Bun's isolated linker keeps packages in node_modules/.bun and symlinks them from server/node_modules.
COPY --from=deps /build/node_modules node_modules
COPY --from=deps /build/server/node_modules server/node_modules
COPY server/package.json server/package.json
COPY server/src server/src
COPY server/migrations server/migrations
COPY catalog catalog
COPY --from=web /build/admin-web/dist admin-web/dist
USER bun
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["bun", "server/src/index.ts"]
