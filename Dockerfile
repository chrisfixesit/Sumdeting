# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY backend/package.json backend/
RUN cd backend && npm install --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-alpine
RUN apk add --no-cache wget

# Run as the unprivileged user provided by the base image
WORKDIR /app
COPY --from=deps --chown=node:node /app/backend/node_modules backend/node_modules
COPY --chown=node:node backend/tutor.mjs backend/
COPY --chown=node:node backend/account/ backend/account/
RUN rm -f backend/account/*.test.mjs backend/account/testkit.mjs
COPY --chown=node:node web/index.html web/
COPY --chown=node:node web/account-core.mjs web/account-ui.mjs web/account-dom.mjs web/account-screens.mjs web/account.css web/
COPY --chown=node:node web/vendor/ web/vendor/
COPY --chown=node:node server.mjs .

ENV NODE_ENV=production \
    PORT=8080

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.mjs"]
