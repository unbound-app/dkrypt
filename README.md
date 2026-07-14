# ipadecrypt-service

Docker Compose service that wraps [londek/ipadecrypt](https://github.com/londek/ipadecrypt)
behind an authenticated HTTP API, run against a jailbroken iPhone reachable
over SSH from the host. Two jobs:

1. **On-demand decrypt** - `GET /v1/decrypt?bundleId=...` decrypts and
   returns any app by bundle ID.
2. **Automated release watch** - on a cron schedule, checks whether the
   currently-live App Store version of `WATCH_BUNDLE_ID` already has a
   matching release in `WATCH_APP_REPO`; if not, decrypts it, temporarily
   hosts the IPA, and fires a `repository_dispatch` (`ipa-update`) at your
   build workflow with a signed, short-lived download URL.

Both paths share one FIFO job queue, because the physical jailbroken device
can only run one `ipadecrypt decrypt` at a time.

## Setup

1. Jailbroken iPhone on the same network as this host, with OpenSSH,
   AppSync Unified, and appinst installed (see the
   [ipadecrypt README](https://github.com/londek/ipadecrypt#requirements)).
2. Copy `.env.example` to `.env` and fill it in. At minimum: `API_KEY`,
   `DOWNLOAD_SIGNING_SECRET`, `PUBLIC_BASE_URL`. Fill in the `WATCH_*` /
   `GH_*` vars too if you want the automated side; leave them blank to
   disable it.
3. Build the image:
   ```sh
   docker compose build
   ```
4. **Bootstrap ipadecrypt once, interactively** (App Store login + device
   SSH details - persisted in the `ipadecrypt-config` volume):
   ```sh
   docker compose run --rm -it api ipadecrypt bootstrap
   ```
5. Start the service:
   ```sh
   docker compose up -d
   ```

## Fronting with Caddy

The `api` service publishes to `127.0.0.1:8080` only. Point a Caddy
instance at it - see `Caddyfile.example`. Whether Caddy runs directly on
the host or as its own container both work:

- **Caddy on the host**: use `reverse_proxy 127.0.0.1:8080` as-is, no
  compose changes needed.
- **Caddy as a container**: uncomment the `caddy` service in
  `docker-compose.yml`, drop the `ports:` block from `api` (so it's only
  reachable inside the compose network), and use `reverse_proxy api:8080`
  in the Caddyfile instead.

Caddy's `reverse_proxy` has no request timeout by default, so long-running
decrypts won't get cut off mid-request.

## API

All routes require `Authorization: Bearer <API_KEY>` - there is no
unauthenticated path, including health checks.

### `GET /v1/decrypt?bundleId=<id>`
Starts (or joins an in-flight) decrypt job and blocks until it's done,
then streams the `.ipa` directly. Falls back to `202` with a status/file
URL if it's still running after `JOB_MAX_WAIT_SECONDS`.

### `GET /v1/jobs/:id`
Job status: `queued | running | done | failed`, plus the last progress
line reported by the `ipadecrypt` CLI.

### `GET /v1/jobs/:id/file`
Streams the finished IPA. Accepts either the master `API_KEY` or a signed
`?token=` (used internally for the GitHub Actions payload). The file is
deleted from disk immediately after a successful download, or after
`FILE_TTL_MINUTES` if nobody ever downloads it.

### `GET /v1/health`
Liveness + whether the scheduler is enabled. Still requires the API key.

## Notes / limitations

- Only free apps are supported (same limitation as `ipadecrypt` itself).
- The queue is a simple in-memory FIFO - restarting the container drops
  any in-flight/queued jobs (the physical device only supports one worker
  anyway, so this hasn't been built out further).
- Version matching for the automated watch compares the iTunes Lookup API
  `version` field against release tags in `WATCH_APP_REPO`, normalizing a
  leading `v` (`v334.0` vs `334.0`). It looks for an *exact* match, not
  "newer than" - if your release tags diverge from the App Store version
  scheme this will need adjusting in `api/src/util/version.ts`.
