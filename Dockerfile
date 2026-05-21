# syntax=docker/dockerfile:1.7

# ── Builder ────────────────────────────────────────────────────────────────
# We need python+build-essential because better-sqlite3 ships C++ that has to
# compile if there's no prebuilt for our platform. Using bookworm-slim (glibc)
# so the better-sqlite3 prebuilts work out of the box.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests first so npm install can be cached when only
# source files change.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY cli/package.json   ./cli/

# Install all workspace deps (incl. dev). We need tsc here.
RUN npm ci --workspaces --include-workspace-root

# Now copy the actual sources.
COPY shared/ ./shared/
COPY server/ ./server/
COPY cli/    ./cli/

RUN npm run build -w shared \
  && npm run build -w server

# Drop dev deps for the runtime image. Keep workspaces wired so the file:
# linking between server and @surd/shared still resolves.
RUN npm prune --omit=dev --workspaces --include-workspace-root


# ── Runtime ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# curl is for the HEALTHCHECK; ca-certificates for outbound HTTPS if we ever
# add it (e.g. webhook calls).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server ./server

ENV NODE_ENV=production
ENV SURD_HOST=0.0.0.0
ENV SURD_PORT=4455
# /data is intended to be mounted from a persistent volume (Azure Files,
# Fly volumes, K8s PVC, etc). If unmounted, surd will create it in-container
# and any state is lost on restart.
ENV SURD_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 4455
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:4455/health || exit 1

RUN mkdir -p /data

# Note: we stay as root here on purpose. Azure Container Apps mounts Azure
# Files volumes as root:root with restrictive perms, so dropping to a
# non-root user produces EACCES on /data writes. The blast radius is just
# this single container with one bound port; the SURD_TOKEN secret stays
# in env vars regardless of UID.

CMD ["node", "--enable-source-maps", "server/dist/index.js"]
