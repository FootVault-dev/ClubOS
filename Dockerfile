# Multi-stage build: install all deps and build, then ship a runtime image
# with only what's needed at runtime.

FROM node:20-slim AS builder
WORKDIR /app

# Build stage needs all deps including dev (for vite, esbuild, tsx)
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Vite reads VITE_* env vars at build time and inlines them into the client
# bundle. Fly secrets are runtime-only, so these must be passed via
# `fly deploy --build-arg VITE_FOO=...` and re-exported as ENV before build.
ARG VITE_STRIPE_PUBLISHABLE_KEY
ARG VITE_META_PIXEL_ID
ENV VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY
ENV VITE_META_PIXEL_ID=$VITE_META_PIXEL_ID
# The commit this image was built from, so production can be ASKED what it runs
# instead of a local file being trusted to remember. `.last-deployed-sha` is
# gitignored, so every worktree carries its own copy and they drift apart — which
# is how a deploy from one worktree silently removed POS on 2026-09-09.
ARG GIT_SHA
ENV BUILD_SHA=$GIT_SHA

COPY . .
RUN npm run build

FROM node:20-slim AS runner

# 🔴 The commit this image was built from, read at RUNTIME by GET /api/version
# so deploy.sh can ask PRODUCTION what it runs instead of trusting a local
# .last-deployed-sha (which is gitignored, so every worktree carries its own
# and they disagree — that is how a live feature was deleted on 2026-09-09).
# It MUST be declared here as well as in the builder: an ENV set in one stage
# does not cross into another, so the builder's copy never reaches the running
# container and the endpoint answered {"sha":null}.
ARG GIT_SHA
ENV BUILD_SHA=$GIT_SHA
WORKDIR /app
ENV NODE_ENV=production

# Runtime only needs production deps. The bundle in dist/index.cjs already
# inlines the allowlisted deps (see script/build.ts), but the externals
# (most node_modules) still need to be installed here.
COPY package*.json ./
RUN npm install --production --legacy-peer-deps && \
    npm cache clean --force

# Bundled server + built client static files
COPY --from=builder /app/dist ./dist

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.cjs"]
