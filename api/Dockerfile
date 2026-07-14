# --- ipadecrypt CLI (Go) ---
FROM golang:1.25-bookworm AS ipadecrypt
RUN go install github.com/londek/ipadecrypt/cmd/ipadecrypt@latest

# --- runtime ---
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=ipadecrypt /go/bin/ipadecrypt /usr/local/bin/ipadecrypt
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "\
    fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/v1/health', \
      { headers: { authorization: 'Bearer ' + process.env.API_KEY } }) \
      .then((r) => process.exit(r.ok ? 0 : 1)) \
      .catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
