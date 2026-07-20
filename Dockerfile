FROM node:20-bookworm-slim AS workspace
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/llm-worker/package.json apps/llm-worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/llm-core/package.json packages/llm-core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma:generate

FROM workspace AS api
RUN pnpm --filter @extractionstack/shared build \
    && pnpm --filter @extractionstack/llm-core build \
    && pnpm --filter @extractionstack/api build
EXPOSE 3001
USER node
CMD ["pnpm", "--filter", "@extractionstack/api", "start"]

FROM workspace AS worker
RUN mkdir -p /ms-playwright \
    && pnpm --filter @extractionstack/shared build \
    && pnpm --filter @extractionstack/worker build \
    && pnpm --filter @extractionstack/api exec playwright install --with-deps chromium \
    && chown -R node:node /ms-playwright
USER node
CMD ["pnpm", "--filter", "@extractionstack/worker", "start"]

FROM workspace AS llm-worker
RUN pnpm --filter @extractionstack/shared build \
    && pnpm --filter @extractionstack/llm-core build \
    && pnpm --filter @extractionstack/llm-worker build
USER node
CMD ["pnpm", "--filter", "@extractionstack/llm-worker", "start"]

FROM workspace AS web-build
ARG VITE_API_BASE_URL=
ARG VITE_AUTH_DEV_MODE=false
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_AUTH_DEV_MODE=$VITE_AUTH_DEV_MODE
RUN pnpm --filter @extractionstack/shared build && pnpm --filter @extractionstack/web build

FROM nginx:1.27-alpine AS web
COPY ops/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
