# syntax=docker/dockerfile:1
# Dependency-light conformance image. The opt-in web-app composition requires
# sibling source checkouts and is intentionally not available in this image.
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests
COPY --chown=node:node scripts ./scripts
USER node
CMD ["npm", "test"]
