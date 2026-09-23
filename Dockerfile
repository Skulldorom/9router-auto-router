# Production builds pass decolua/9router@sha256:... after validating that exact image.
ARG UPSTREAM_IMAGE=decolua/9router:latest
FROM ${UPSTREAM_IMAGE}

ARG AUTO_ROUTER_REVISION=unknown
ARG UPSTREAM_IMAGE_NAME=decolua/9router:latest
ARG UPSTREAM_DIGEST=unknown
ARG UPSTREAM_VERSION=unknown
ARG BUILD_CREATED=unknown

LABEL org.opencontainers.image.source="https://github.com/Skulldorom/9router-auto-router" \
      org.opencontainers.image.revision="${AUTO_ROUTER_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      org.opencontainers.image.title="9router-auto-router" \
      org.opencontainers.image.description="Validated Auto Router overlay for 9Router" \
      io.github.skulldorom.9router-auto-router.upstream.image="${UPSTREAM_IMAGE_NAME}" \
      io.github.skulldorom.9router-auto-router.upstream.digest="${UPSTREAM_DIGEST}" \
      io.github.skulldorom.9router-auto-router.upstream.version="${UPSTREAM_VERSION}"

COPY auto-router-config.cjs /opt/auto-router-config.cjs
COPY src/auto-router.cjs /opt/9router-auto-router/auto-router.cjs
COPY patches/apply-patch.mjs /opt/9router-auto-router/apply-patch.mjs
RUN node /opt/9router-auto-router/apply-patch.mjs /app && \
    chown -R node:node /opt/9router-auto-router

# Deliberately preserve upstream ENTRYPOINT, CMD, EXPOSE, DATA_DIR and volumes.
