# syntax=docker/dockerfile:1
# Dependency-light conformance image. The opt-in web-app composition requires
# sibling source checkouts and is intentionally not available in this image.
FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests
COPY --chown=node:node scripts ./scripts
USER node
CMD ["npm", "test"]
