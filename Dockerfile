# syntax=docker/dockerfile:1
# Model files are NOT baked in; mount them at /app/sentiment-engine/models (see README).

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY sentiment-engine/ sentiment-engine/
RUN sentiment-engine/scripts/fetch-onnxruntime.sh && make -C sentiment-engine

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY tsconfig.base.json ./
COPY scripts/ scripts/
COPY shared/ shared/
COPY server/ server/
COPY web/ web/
RUN npm run build:app && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/portal.sqlite
WORKDIR /app
# Same absolute paths as the build stage: the engine's rpath points at /app/sentiment-engine/third_party.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist/ shared/dist/
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist/ server/dist/
COPY --from=build /app/web/dist/ web/dist/
COPY --from=build /app/sentiment-engine/build/ sentiment-engine/build/
COPY --from=build /app/sentiment-engine/third_party/onnxruntime/lib/ sentiment-engine/third_party/onnxruntime/lib/
RUN mkdir -p /data sentiment-engine/models && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
