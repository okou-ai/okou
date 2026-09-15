FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

FROM runtime AS build
WORKDIR /source
RUN corepack enable
COPY turbo/ ./turbo/
WORKDIR /source/turbo
RUN pnpm install --frozen-lockfile --filter @okouai/media-worker...
RUN pnpm --filter @okouai/media-worker check-types && pnpm --filter @okouai/media-worker test && pnpm --filter @okouai/media-worker build

FROM runtime
ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
ENV PORT=8080
LABEL org.opencontainers.image.revision=$GIT_COMMIT_SHA
WORKDIR /worker
COPY --from=build /source/turbo/apps/media-worker/dist/index.mjs ./dist/index.mjs
USER node
EXPOSE 8080
CMD ["node", "dist/index.mjs"]
