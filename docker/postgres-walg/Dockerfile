FROM postgres:17-alpine

ARG WALG_VERSION=v3.0.5
ARG TARGETARCH=amd64

RUN apk add --no-cache ca-certificates curl tar libsodium \
    && curl -fsSL "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-ubuntu-20.04-${TARGETARCH}.tar.gz" -o /tmp/walg.tar.gz \
    || true

# Fallback: install prebuilt musl/linux binary or compile if needed;
# For Alpine, wal-g static binary or gcompat is required when using glibc release
RUN apk add --no-cache gcompat \
    && if [ -f /tmp/walg.tar.gz ]; then \
         tar -xzf /tmp/walg.tar.gz -C /usr/local/bin && \
         mv /usr/local/bin/wal-g-pg-* /usr/local/bin/wal-g 2>/dev/null || true; \
       fi \
    && rm -f /tmp/walg.tar.gz \
    && chmod +x /usr/local/bin/wal-g 2>/dev/null || true
