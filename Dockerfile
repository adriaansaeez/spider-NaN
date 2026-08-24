# ─────────────────────────────── Stage 1: build ───────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src/ ./src/
COPY public/ ./public/

# tsc --noEmit && vite build  (vite base is '/game/')
RUN npm run build

# Vite emits the game bundle and the public/ copies at the dist root, but with
# base '/game/' every referenced URL is /game/... — so the game document and its
# assets have to physically move under dist/game/.
RUN mkdir -p dist/game \
 && mv dist/index.html dist/game/index.html \
 && mv dist/assets     dist/game/assets

# The presentation is the landing page at the served root, and the media it
# references (/captures, /docs, /reference-pack) sits beside it as siblings.
COPY presentacion/index.html ./dist/index.html
COPY captures/         ./dist/captures/
COPY docs/             ./dist/docs/
COPY reference-pack/   ./dist/reference-pack/

# ─────────────────────────────── Stage 2: serve ───────────────────────────────
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 80
