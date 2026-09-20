# Pin this at build time. The default is the upstream release validated by CI.
ARG UPSTREAM_IMAGE=decolua/9router:0.5.75
FROM ${UPSTREAM_IMAGE}

COPY src/auto-router.cjs /opt/9router-auto-router/auto-router.cjs
COPY patches/apply-patch.mjs /opt/9router-auto-router/apply-patch.mjs
RUN node /opt/9router-auto-router/apply-patch.mjs /app && \
    chown -R node:node /opt/9router-auto-router

# Deliberately preserve upstream ENTRYPOINT, CMD, EXPOSE, DATA_DIR and volumes.
