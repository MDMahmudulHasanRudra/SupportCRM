# Support CRM API / worker — one image, two run modes (RUN_MODE=api | worker).
#
# PROJECT_SPEC.md §150, §201: deterministic production build, no dev toolchain in the runtime
# image, non-root process.

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

# Manifests first so the dependency layer caches independently of source changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
# --frozen-lockfile with no fallback: a production build must be deterministic (PROJECT_SPEC.md
# §151). If the lockfile is stale the build should fail loudly, not quietly resolve something else.
RUN pnpm install --frozen-lockfile

COPY apps/api ./apps/api
RUN pnpm --filter @support-crm/api build

# Re-resolve with dev dependencies stripped, so only runtime packages are copied forward.
# --legacy: this workspace does not use injected dependencies, which pnpm v10+ requires for the
# default deploy path. --node-linker=hoisted produces a plain, self-contained node_modules with no
# symlinks into a pnpm store — the runtime stage has no store to point at.
RUN pnpm --filter @support-crm/api deploy --prod --legacy --node-linker=hoisted /tmp/deploy

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Non-root. The node image ships an unprivileged `node` user; use it rather than minting one.
COPY --from=build --chown=node:node /tmp/deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./package.json

# The upload directory, created here and owned by the runtime user.
#
# This is not cosmetic. `STORAGE_LOCAL_PATH` is backed by a named volume, and Docker initialises an
# empty volume from whatever the image has at that path — including its ownership. Without this the
# volume arrives owned by root, the unprivileged process cannot write to it, and every knowledge
# document upload fails while the health check reports storage CRITICAL.
RUN mkdir -p /app/storage && chown -R node:node /app/storage

USER node

# API mode. The worker overrides this with `node dist/worker.js` (see docker-compose.yml).
CMD ["node", "dist/main.js"]
