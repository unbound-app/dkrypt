FROM golang:1.25-bookworm AS ipadecrypt
ARG IPADECRYPT_VERSION=v0.7.3
RUN go install github.com/londek/ipadecrypt/cmd/ipadecrypt@${IPADECRYPT_VERSION}

FROM oven/bun:1-slim AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ipadecrypt /go/bin/ipadecrypt /usr/local/bin/ipadecrypt
COPY package.json bun.lock tsconfig.json ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY --from=web /public ./public

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "\
    fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/v1/health', \
      { headers: { authorization: 'Bearer ' + process.env.API_KEY } }) \
      .then((r) => process.exit(r.ok ? 0 : 1)) \
      .catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
