FROM golang:1.27-bookworm AS ipadecrypt
ARG IPADECRYPT_VERSION=v0.7.3
RUN go install github.com/londek/ipadecrypt/cmd/ipadecrypt@${IPADECRYPT_VERSION}

FROM rust:1.89-bookworm AS device-bridge
WORKDIR /bridge
COPY packages/device-bridge/Cargo.toml packages/device-bridge/Cargo.lock ./
COPY packages/device-bridge/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim AS netmuxd
ARG NETMUXD_VERSION=v0.4.3
ARG TARGETARCH=amd64
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "${TARGETARCH}" in \
    amd64) asset=netmuxd-x86_64-unknown-linux-gnu.tar.gz; checksum=85b6598284fc639f2a282584461d05e2090b79bdf3ec949d2a5e5d3dc655dde4 ;; \
    arm64) asset=netmuxd-aarch64-unknown-linux-gnu.tar.gz; checksum=a89d587b094184b41431bc343da6dfa890391ccc7d4b3d6bce02b524f3191ae6 ;; \
    *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl --fail --silent --show-error --location "https://github.com/jkcoxson/netmuxd/releases/download/${NETMUXD_VERSION}/${asset}" --output /tmp/netmuxd.tar.gz; \
  echo "${checksum}  /tmp/netmuxd.tar.gz" | sha256sum --check; \
  tar --extract --file /tmp/netmuxd.tar.gz --directory /usr/local/bin; \
  chmod 0755 /usr/local/bin/netmuxd

FROM oven/bun:1.3.14-slim AS web
WORKDIR /web
COPY packages/dkrypt/web/package.json packages/dkrypt/web/bun.lock ./
RUN bun install --frozen-lockfile
COPY packages/dkrypt/web ./
ARG BUILD_REF=development
ENV VITE_BUILD_REF=$BUILD_REF
RUN bun run build

FROM oven/bun:1.3.14-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates findutils libusb-1.0-0 passwd util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 dkrypt && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dkrypt
RUN touch /device-ssh-key-source && chmod 0600 /device-ssh-key-source

COPY --from=ipadecrypt /go/bin/ipadecrypt /usr/local/bin/ipadecrypt
COPY --from=device-bridge /bridge/target/release/dkrypt-device-bridge /usr/local/bin/dkrypt-device-bridge
COPY --from=netmuxd /usr/local/bin/netmuxd /usr/local/bin/netmuxd
COPY packages/dkrypt/package.json packages/dkrypt/bun.lock packages/dkrypt/tsconfig.json ./
RUN bun install --production --frozen-lockfile
COPY packages/dkrypt/src ./src
COPY packages/dkrypt/entrypoint.sh /usr/local/bin/dkrypt-entrypoint
COPY --from=web /public ./public
RUN chmod 0755 /usr/local/bin/dkrypt-entrypoint

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "\
    fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/v1/health', \
      { headers: { authorization: 'Bearer ' + process.env.API_KEY } }) \
      .then((r) => process.exit(r.ok ? 0 : 1)) \
      .catch(() => process.exit(1))"

CMD ["/usr/local/bin/dkrypt-entrypoint"]
