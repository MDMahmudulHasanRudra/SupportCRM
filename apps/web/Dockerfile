# The operator console.
#
# Built here rather than on the host so `docker compose up --build` is the whole deployment: the
# previous arrangement mounted a host-built `dist/` into the proxy, which meant a deploy silently
# served whatever bundle happened to be lying around — or a 404 page if nobody had run the build.
#
# The result is static files. There is no Node process at runtime and no server-side rendering: the
# console is a bundle the browser downloads, and every request it then makes goes to the API through
# the reverse proxy on the same origin.
#
# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

# The workspace manifests first, so a change to application source does not invalidate the
# dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @support-crm/web...

COPY apps/web ./apps/web

# Deliberately built with no VITE_API_URL. Left unset, the console calls the API on its own origin,
# which is what makes one image work behind any hostname without a rebuild. Baking a URL in here
# would tie the image to a single deployment — and, in development, to localhost.
RUN pnpm --filter @support-crm/web build

# ---- runtime ----------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# SPA fallback: the console owns its routes, so a refresh on /reports must return index.html rather
# than nginx's 404. Without this, every deep link breaks on reload.
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

# Serves on :80 inside the compose network only. The edge proxy is what the internet talks to.
CMD ["nginx", "-g", "daemon off;"]
