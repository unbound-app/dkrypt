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

A third path, **TestFlight builds**, lets you browse an app's beta trains,
install a specific build, and decrypt it (`ipadecrypt decrypt
--use-installed`) - see **TestFlight builds** below for the extra
device-side setup this needs.

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

Access is four independent, additive permissions, enforced server-side (the
UI just hides what a user can't do). A newly-added user starts with none of
them - pure read-only - and gains capabilities as an admin grants them,
rather than picking from a fixed tier:

- **decrypt** - queue decrypts, and manage their own API keys (request,
  reveal-once, regenerate, revoke) - a request sits as `pending` until
  someone with `manageKeys` approves it on the API Keys tab.
- **manageKeys** - approve/deny pending key requests, view the full key
  list across every user, bulk-revoke, and their own key requests
  auto-approve instead of queuing.
- **manageSettings** - the Scheduler settings sub-tab (watch/dispatch
  config, cron, webhook, manual dispatch trigger).
- **manageUsers** - the Users settings sub-tab: add/remove people from the
  allowlist and change their permissions. A user can't remove their own
  `manageUsers` - get another user with it to do that, or fall back to
  `ADMIN_PASSWORD`.

Apple ID re-authentication needs **both** `manageSettings` and
`manageUsers` - the same combination the old `admin` role uniquely had -
since it puts real Apple ID credentials through the pipeline and shouldn't
be reachable by a settings-only or users-only grant.

The Users tab presents these as a checklist plus quick presets (Viewer /
Member / Manager / Admin) that just fill the checkboxes - any custom
combination is still one edit away.

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
- **API Keys** (needs `decrypt` or `manageKeys`) - request/reveal/
  regenerate/revoke your own keys; anyone with `manageKeys` additionally
  sees all pending requests (approve/deny), the full key list across every
  user, and can create an auto-approved key directly (e.g. for a CI
  runner). Keys are stored hashed - the plaintext is only ever shown once,
  right after approval/regeneration. The root `API_KEY` from `.env` always
  works too and isn't managed here.
- **Logs** - a live feed of scheduler/job log lines, filterable by scope
  (all/scheduler/jobs) and level (info/warning/error).
- **Docs** - copy-pasteable curl examples for using an API key, filled in
  with this instance's actual `PUBLIC_BASE_URL`.
- **Settings** (needs `manageSettings` or `manageUsers`) - sub-tabs shown
  depend on which of the two you have:
  - *Scheduler* (`manageSettings`) - edit the watch bundle ID,
    watch/dispatch repos, workflow file, poll cron, and notification
    webhook URL live, no restart needed. `GH_TOKEN` and `API_KEY` stay
    env-only, not editable here.
  - *Users* (`manageUsers`) - the GitHub OAuth allowlist: add a username
    with a permission set, or open the Manage dialog on an existing entry
    to change their permissions or remove them. A user can't remove their
    own `manageUsers` permission - get someone else with it to do that, or
    fall back to `ADMIN_PASSWORD`.
  - *Apple Auth* (`manageSettings` + `manageUsers`) - re-runs just the App Store sign-in step of `ipadecrypt
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

`ipadecrypt versions` shows a one-time interactive warning before it'll
fetch anything ("too many in a short window can get your Apple ID
flagged..."). This service answers it automatically (spawns the CLI
through a real pty and sends Enter the first time it sees the prompt,
whether or not it's been answered before) - no manual step needed, and it
survives a fresh `appstore-config` volume the same way `ipadecrypt
bootstrap` doesn't (bootstrap's App Store login still has to be done once,
interactively, per the Setup steps above).

## TestFlight builds

Browsing/installing TestFlight builds needs a small companion tweak,
[unbound-app/tfauto](https://github.com/unbound-app/tfauto), installed on
the jailbroken device (rootless, ElleKit). It does two things dkrypt's own
SSH access can't: drives TestFlight's own installer to actually install a
chosen build, and launches TestFlight in the first place in a way that
still works with the device's screen off (SpringBoard normally refuses a
foreground launch to anything if the display isn't lit - see that repo's
README for how tfauto works around it). Without it installed, the
TestFlight picker in the dashboard and the scheduler's TestFlight watch
will fail with a connection/bridge error - the rest of dkrypt works fine
without it.

Once installed, nothing else is needed on dkrypt's side - `api/src/
testflight.ts` talks to it over the same SSH connection already configured
for `ipadecrypt` (reads the device host/port/key straight out of
`ipadecrypt`'s own config, no separate credentials).

## Notes / limitations

- Only free apps are supported (same limitation as `ipadecrypt` itself).
- The queue is a simple in-memory FIFO - restarting the container drops
  any in-flight/queued jobs (the physical device only supports one worker
  anyway, so this hasn't been built out further).
- Version matching for the automated App Store watch compares the iTunes
  Lookup API `version` field against release tags in `WATCH_APP_REPO`,
  normalizing a leading `v` (`v334.0` vs `334.0`). It looks for an *exact*
  match, not "newer than" - if your release tags diverge from the App
  Store version scheme this will need adjusting in `api/src/util/
  version.ts`.
- The scheduler also always watches TestFlight for new builds of
  `WATCH_BUNDLE_ID` (its numeric App Store ID is resolved automatically
  via the same iTunes lookup, no separate config), matching tags shaped
  `v{shortVersion}_{buildNumber}` (e.g. `v1.0.0_106191`) - a different,
  exact-string match against the *raw* tag name, not the normalized App
  Store comparison above. Fails silently (logged, not fatal) if `tfauto`
  isn't installed on the device - see **TestFlight builds**.
