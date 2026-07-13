# syntax=docker/dockerfile:1
# Dependency-light conformance image. The opt-in web-app composition requires
# sibling source checkouts and is intentionally not available in this image.
FROM node:26.5.0-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests
COPY --chown=node:node scripts ./scripts
USER node
CMD ["npm", "test"]
