# Official library/node 24-bookworm-slim metadata resolved 2026-10-16.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /project/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts ./
COPY apps/web/src ./src
COPY apps/web/public ./public
COPY locales /project/locales
RUN npm run build

# Official library/nginx stable-alpine metadata resolved 2026-10-16.
FROM nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
ARG NGINX_CONFIG=containers/nginx.conf
COPY ${NGINX_CONFIG} /etc/nginx/nginx.conf
COPY --from=build /project/apps/web/dist /srv/public
COPY LICENSE /srv/public/LICENSE
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
