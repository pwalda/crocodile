# Build from the repository root:  docker build -f apps/directory/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @crocodile/directory build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/apps/directory/dist/bin.js ./bin.js
ENV CROC_DIR_STATE=/data/directory.json
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 7400
USER node
CMD ["node", "bin.js"]
