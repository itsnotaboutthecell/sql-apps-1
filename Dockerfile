FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY application.json runtime-contract.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY plugins/sql-apps ./plugins/sql-apps
COPY sql ./sql
COPY dab ./dab
COPY infra ./infra
COPY tsconfig*.json ./
COPY src ./src
COPY functions ./functions
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
