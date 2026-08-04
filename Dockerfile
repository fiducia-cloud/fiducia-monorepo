# syntax=docker/dockerfile:1
# Dependency-light conformance image. The opt-in web-app composition requires
# sibling source checkouts and is intentionally not available in this image.
FROM node:26.5.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests
COPY --chown=node:node scripts ./scripts
USER node
CMD ["npm", "test"]
