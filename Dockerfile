# syntax=docker/dockerfile:1.7

# ---------- Build stage ----------
FROM node:22-slim AS builder

WORKDIR /app

# Toolchain pra compilar better-sqlite3 caso o prebuilt nao bata.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Lockfile separado pra aproveitar cache de layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Joga fora devDeps depois do build.
RUN npm prune --omit=dev


# ---------- Runtime stage ----------
FROM node:22-slim AS runtime

# Usuario nao-root.
RUN groupadd -r mcp && useradd -r -g mcp -d /app -s /sbin/nologin mcp

WORKDIR /app

COPY --from=builder --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
COPY --chown=mcp:mcp package.json ./
COPY --chown=mcp:mcp sql ./sql

# Volume para SQLite (clients OAuth, codes, refresh, audit_log).
RUN mkdir -p /data && chown mcp:mcp /data
VOLUME ["/data"]

USER mcp

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    SQLITE_PATH=/data/app.db

EXPOSE 3000

# Node 22 tem fetch global - sem dep extra pro healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
