# Build from the repository root:  docker build -f packages/coordinator/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @crocodile/coordinator build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/packages/coordinator/dist/bin.js ./bin.js
# The release, e.g. 0.2.1 (set by the release workflow); shown in /health.
ARG CROC_VERSION=dev
ENV CROC_DATA_DIR=/data NODE_NO_WARNINGS=1 CROC_VERSION=$CROC_VERSION
# Relayed traffic uses these UDP ports, one per relayed connection: publish
# and open them along with 7443 and 7444, or the opt-in relay can't work.
ENV CROC_RELAY_PORTS=49160-49259
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 7443/tcp 7443/udp 7444/udp 49160-49259/udp
USER node
CMD ["node", "bin.js"]
