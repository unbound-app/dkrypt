# dkrypt

Docker Compose service that wraps [londek/ipadecrypt](https://github.com/londek/ipadecrypt)
behind an authenticated HTTP API, run against a jailbroken iDevice reachable
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

1. Jailbroken iDevice on the same network as this host, with OpenSSH,
   AppSync Unified, and appinst installed (see the
   [ipadecrypt README](https://github.com/londek/ipadecrypt#requirements)).
2. Copy `.env.example` to `.env` and fill it in. Required: `API_KEY`,
   `DOWNLOAD_SIGNING_SECRET`, `PUBLIC_BASE_URL`, `ADMIN_PASSWORD`. Fill in
   the `WATCH_*` / `GH_*` vars too if you want the automated side (leave
   them blank to disable it), and `GITHUB_OAUTH_*` if you want other people
   to log into the dashboard without sharing `ADMIN_PASSWORD`.
3. Build the image:
   ```sh
   docker compose build
   ```
4. **Bootstrap ipadecrypt once, interactively** (App Store login + device
   SSH details - persisted in the `appstore-config` volume). The `api`
   service has a fixed `container_name`, so if it's already running,
   `docker compose run` needs an explicit different name to avoid clashing
   with it:
   ```sh
   docker compose run --rm -it --name dkrypt-bootstrap api ipadecrypt bootstrap
   ```
5. Start the service:
   ```sh
   docker compose up -d
   ```

## Fronting with Caddy

`api` runs with `network_mode: host` (needed so it can reach the jailbroken
device's SSH port - typically a USB-tethered `iproxy ... 2222:22` bound to
127.0.0.1 on the host, which a container on the default bridge network
can't see at all). `BIND_HOST` defaults to `127.0.0.1` so the app itself
still only listens on loopback, not the whole LAN.

This repo doesn't run Caddy itself - point whatever reverse proxy already
fronts your other homelab services at `127.0.0.1:8080` (a container-based
Caddy needs `network_mode: host` too, for the same reason as `api`: a
bridge-network container has no route to a loopback-bound port, and `api`
isn't on any compose network for a service-name DNS entry to exist
either). The root `Caddyfile` is a copy-pasteable fragment for that,
pointed at this reference deployment's domain - swap it for your own.

Caddy's `reverse_proxy` has no request timeout by default, so long-running
decrypts won't get cut off mid-request.

## API

All routes require `Authorization: Bearer <API_KEY>` - there is no
unauthenticated path, including health checks.

### `GET /v1/decrypt?bundleId=<id>&externalVersionId=<id>`
Starts (or joins an in-flight) decrypt job and blocks until it's done,
then streams the `.ipa` directly. Falls back to `202` with a status/file
URL if it's still running after `JOB_MAX_WAIT_SECONDS`. `externalVersionId`
is optional and pins the decrypt to a specific historical App Store
release instead of the current one - see **Decrypting a specific
version** below for where that id comes from.

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

## Dashboard

`GET /` - a single static page (no build step, no external dependencies).
Two ways in:

- **Root password** (`ADMIN_PASSWORD`) - always logs in as an implicit
  admin. Your recovery path if everything else is locked out.
- **Sign in with GitHub** - only shown if `GITHUB_OAUTH_CLIENT_ID` /
  `GITHUB_OAUTH_CLIENT_SECRET` are set (see `.env.example` for how to
  register the OAuth App). A successful GitHub login only grants access if
  that username is on the **Settings → Users** sub-tab's allowlist -
  registering the OAuth app doesn't let just anyone in, an admin has to
  add them first (chicken-and-egg: add yourself via `ADMIN_PASSWORD`
  first).

Four roles, enforced server-side (the UI just hides what a role can't do):

- **admin** - everything below, plus the Settings tab (Scheduler, Users,
  Apple Auth).
- **operator** - everything admin can do *except* the Settings tab: queues
  decrypts, and manages API keys for everyone (approve/deny pending
  requests, view the full key list, bulk-revoke, own requests auto-approve).
- **member** - Home, API Keys, Logs, and Docs, and manages their *own* API
  keys (request, reveal-once, regenerate, revoke) - but a request sits as
  `pending` until an admin or operator approves it on the API Keys tab.
- **viewer** - read-only: Home, Logs, and Docs, but can't queue a decrypt,
  and has no API Keys tab (nothing to request or manage).

Per-account preferences (currently just light/dark theme) are synced
server-side, not just `localStorage` - switching browsers or devices keeps
your last choice.

Tabs:

- **Home** - search the App Store and queue a decrypt, your own
  queued/finished requests, scheduler on/off, active jobs, recent history,
  and a banner if a decrypt failure looked like an App Store auth issue.
  Each free result has a clock-icon button that opens its App Store
  version history and lets you decrypt an older release instead of the
  current one (`ipadecrypt decrypt --external-version-id`) - see
  **Decrypting a specific version** below.
- **API Keys** (not shown to viewers) - request/reveal/regenerate/revoke
  your own keys; admins and operators additionally see all pending
  requests (approve/deny), the full key list across every user, and can
  create an auto-approved key directly (e.g. for a CI runner). Keys are
  stored hashed - the plaintext is only ever shown once, right after
  approval/regeneration. The root `API_KEY` from `.env` always works too
  and isn't managed here.
- **Logs** - a live feed of scheduler/job log lines, filterable by scope
  (all/scheduler/jobs) and level (info/warning/error).
- **Docs** - copy-pasteable curl examples for using an API key, filled in
  with this instance's actual `PUBLIC_BASE_URL`.
- **Settings** (admin) - three sub-tabs:
  - *Scheduler* - edit the watch bundle ID, watch/dispatch repos, workflow
    file, poll cron, and notification webhook URL live, no restart
    needed. `GH_TOKEN` and `API_KEY` stay env-only, not editable here.
  - *Users* - the GitHub OAuth allowlist: add a username with a role, or
    open the Manage dialog on an existing entry to change their role or
    remove them. An admin can't change their own role or remove themselves
    - get another admin to do it, or fall back to `ADMIN_PASSWORD`.
  - *Apple Auth* - re-runs just the App Store sign-in step of `ipadecrypt
    bootstrap` (email/password, and a 2FA code if Apple asks for one) as
    a piped child process, streaming its prompts to the page so you don't
    need to SSH in for routine re-auth. It deliberately can't drive the
    device-setup wizard's interactive arrow-key menu - only `device.*`
    fields stay untouched (so that step is skipped entirely), never the
    full wizard. See the note below on why a fully headless approach
    isn't possible.

**Auth-failure detection**: there's no headless way to proactively check
whether the App Store session is still valid - `ipadecrypt versions` is an
interactive TUI, not scriptable. Instead, any decrypt job failure is
pattern-matched against common re-auth error text (`login failed`,
`reauthenticate`, `invalid credentials`, etc.); a match sets a persistent
alert (cleared automatically by the next successful decrypt or a
successful Apple Auth re-run) and, if `NOTIFY_WEBHOOK_URL` is set, posts a
Discord-webhook-shaped notification. If it turns out sessions expire
more/less often than expected, this is the place to tighten the detection
(`api/src/util/appleAuth.ts`).

**Decrypting a specific version**: `ipadecrypt decrypt` supports pinning
to a historical release via `--external-version-id`, and this service
exposes it (`GET /v1/dashboard/versions/:bundleId` in the dashboard, the
`externalVersionId` param on the API). What it can *not* safely do is
resolve those opaque ids to human-readable version numbers on its own -
that requires a separate Apple API call per version, and `ipadecrypt`'s
own author gates it behind an interactive warning precisely because
hitting it too many times in a short window risks getting the signed-in
Apple ID flagged, rate-limited, or banned. So the version picker only
shows a version number for releases someone has already opened
(interactively, on the host) via `ipadecrypt versions <bundle-id>` -
that command caches what it fetches to disk, and this service reads that
cache plus its list of every external-version-id. Anything without a
cached number is still fully decryptable, just labeled by its raw id
instead of e.g. `v1.4.2`.

The very first time this service tries to list any app's versions, it'll
fail with a message telling you to SSH in and run
`docker compose exec api ipadecrypt versions <any-bundle-id>` once,
press Enter to accept Apple's rate-limit warning, and then Ctrl-C out -
that's a one-time per-install step (the acceptance is persisted in the
`appstore-config` volume), same as `ipadecrypt bootstrap`.

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
