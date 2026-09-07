# syntax=docker/dockerfile:1

# Node 22 to match the API. Nothing here requires it, but running the two
# services on different runtimes is a difference nobody wants to debug later.

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies before source, so editing a controller does not reinstall them.
# npm ci when a lockfile is committed, npm install when it is not, so the image
# builds either way.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json nest-cli.json ./
COPY src ./src
# Plain tsc, not nest build — the compiled migrations have to land in dist
# alongside everything else, because the app runs them itself on start-up.
RUN npm run build

# ---- runtime dependencies -------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3003

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts ./scripts

USER node
EXPOSE 3003

# Listing assets returns 200, and it can only do that after querying the assets
# table — so this proves the database is reachable and the migration has run.
# Fetching one by id is not usable here: the id is parsed as a UUID, so a made
# up value answers 400 without ever touching the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/assets?limit=1').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
