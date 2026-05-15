# syntax=docker/dockerfile:1.7

# ─── build stage ─────────────────────────────────────────────────────────────
# Install everything (incl. devDeps) and produce the Vite-built frontend in
# dist/web/. Server stays as .ts on disk — tsx executes it directly at runtime.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY shared ./shared
COPY web ./web
RUN npm run build

# ─── runtime stage ───────────────────────────────────────────────────────────
# Production-only deps + tsx (used to execute server/*.ts). Server source and
# the built frontend are copied in; nothing in the image needs the toolchain.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

# Production deps only. tsx is listed under dependencies (not devDependencies)
# because the runtime image executes the server with it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server
COPY --from=build /app/dist ./dist

EXPOSE 8787

# tini-less for now; Node handles SIGTERM fine for graceful shutdown.
CMD ["npx", "tsx", "server/index.ts"]
