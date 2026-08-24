# ─────────────────────────────── Stage 1: build ───────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src/ ./src/
COPY public/ ./public/

# tsc --noEmit && vite build
RUN npm run build

# Vite only copies public/ into dist. The presentation page and the media it
# references live at the dist root as siblings of /presentacion/, so its
# ../-relative links resolve when served from /presentacion/.
COPY presentacion/     ./dist/presentacion/
COPY captures/         ./dist/captures/
COPY docs/             ./dist/docs/
COPY reference-pack/   ./dist/reference-pack/

# ─────────────────────────────── Stage 2: serve ───────────────────────────────
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 80
