# Image for the API Cloud Run service and the batch Cloud Run Jobs.
# The API is the default command; jobs override it with --command / --args.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

# Copy everything from builder — full node_modules avoids any subpath resolution
# issues that occur when re-installing or pruning in the runtime stage.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

CMD ["node", "dist/index.js"]
