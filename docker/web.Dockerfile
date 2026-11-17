# syntax=docker/dockerfile:1.6
# Radar Lichtblick web image: upstream Lichtblick (pinned) + built-in eagle-radar extension.
# Build context: repository root.

############################################
# 1) manifests: keep only what yarn install needs, so the dependency layer is
#    cached until a package.json / lockfile / patch changes.
############################################
FROM node:22-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
 && find . \( -name node_modules -o -name .webpack -o -path ./extensions -o -path ./services \) -prune -o -name package.json -print0 \
    | xargs -0 -I{} cp --parents {} /manifests \
 && cp -r --parents .yarn .yarnrc.yml yarn.lock patches /manifests

############################################
# 2) deps: yarn install (cached)
############################################
FROM node:22 AS deps
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HUSKY=0
WORKDIR /src
RUN corepack enable
COPY --from=manifests /manifests ./
RUN --mount=type=cache,target=/root/.cache yarn install --immutable

############################################
# 3) web build
############################################
FROM deps AS web-build
ENV NODE_OPTIONS=--max-old-space-size=8192
COPY . ./
RUN yarn run web:build:prod

############################################
# 4) eagle-radar extension (standalone bundle, esbuild)
############################################
FROM node:22-slim AS ext-build
WORKDIR /ext
COPY extensions/eagle-radar/package.json extensions/eagle-radar/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY extensions/eagle-radar/ ./
RUN npm run build && npm test --if-present

############################################
# 5) release: static files + reverse proxy to data-server / radar-kpi
############################################
FROM caddy:2-alpine AS release
WORKDIR /src
COPY --from=web-build /src/web/.webpack ./
COPY --from=ext-build /ext/dist/ ./radar-extension/
COPY layouts/radar-analysis.json /lichtblick/default-layout.json
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/web-entrypoint.sh /entrypoint.sh
ENV KPI_UPSTREAM=radar-kpi:8090 \
    DATA_UPSTREAM=data-server:8081
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
