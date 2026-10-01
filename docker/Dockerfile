# syntax=docker/dockerfile:1
# Crate Digger viewer: build the static bundle, serve it with Caddy (automatic HTTPS, basic auth).
# Library data (library.json + covers) is NOT baked in: it is mounted at /srv/data at runtime, so a new
# ingest run updates the site without rebuilding the image.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
# The viewer files albums under the same genre map as the ingest.
COPY ingest/genre-map.json ./ingest/genre-map.json
# Public Spotify app id for "Connect Spotify" (PKCE: no secret). Empty disables the button.
ARG VITE_SPOTIFY_CLIENT_ID=""
ENV VITE_SPOTIFY_CLIENT_ID=$VITE_SPOTIFY_CLIENT_ID
RUN npx vite build

FROM caddy:2-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv/app
RUN mkdir -p /srv/data
EXPOSE 80 443 443/udp
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
