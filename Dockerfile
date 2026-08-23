# syntax=docker/dockerfile:1
# Tooling image for submodule pinning and branch coordination workflows.
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241
LABEL org.fiducia.runtime-profile="tool-runner-nonroot"
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash git ca-certificates \
    && apt-get clean \
    && install -d -o 65532 -g 65532 /workspace/fiducia-monorepo /tmp
WORKDIR /workspace/fiducia-monorepo
COPY --chown=65532:65532 .gitmodules readme.md ./
COPY --chown=65532:65532 docs docs
COPY --chown=65532:65532 scripts scripts
ENV HOME=/tmp
USER 65532:65532

# --- sops: decrypt at `docker run`, never at `docker build` ------------------
# The image carries only CIPHERTEXT (env/enc/<SOPS_ENV>.env.enc) and the sops
# binary. The age key arrives at run time (SOPS_AGE_KEY / SOPS_AGE_KEY_FILE);
# scripts/sops-entrypoint.sh decrypts into the process environment and execs
# the real command, so no plaintext ever lands in a layer or on disk.
# See env/README.md.
ARG SOPS_ENV=local
COPY --chmod=0755 --from=ghcr.io/getsops/sops:v3.10.2-alpine /usr/local/bin/sops /usr/local/bin/sops
COPY --chmod=0755 scripts/sops-entrypoint.sh /usr/local/bin/sops-entrypoint.sh
COPY --chmod=0644 env/enc/${SOPS_ENV}.env.enc /app/secrets/app.env
ENV SOPS_SECRETS_FILE=/app/secrets/app.env

ENTRYPOINT ["/usr/local/bin/sops-entrypoint.sh"]
CMD ["bash", "-lc", "scripts/pin-submodules.sh --help && scripts/checkout-feature-branch.sh --help"]
