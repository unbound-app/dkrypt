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
   build workflow with a signed, short-lived download URL. The scheduler
   records that outcome the moment the dispatch call itself succeeds - it
   doesn't block the next scheduled check on waiting for your build
   workflow to actually finish (which can take a while). It then tracks
   that workflow run in the background and patches the same history entry
   with the final status once it completes, so the Status card's recent
   checks go `dispatched → succeeded/failed` live instead of just sitting
   on "dispatched" until everything's done.

Both paths share one job queue, because the physical jailbroken device can
only run one `ipadecrypt decrypt` at a time. Queuing is FIFO by default, but
manually-queued jobs can carry a priority weight (see **Priority** below) -
scheduler jobs always jump straight to the front regardless.

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

Access is ten independent, additive permissions, enforced server-side (the
UI just hides what a user can't do). A newly-added user starts with none
of them - pure read-only - and gains capabilities one at a time as an
admin grants them, rather than picking from a fixed tier. A few imply
others (checking a stronger switch auto-checks the weaker one it needs):

- **decrypt** - queue decrypts, and manage their own API keys (request,
  reveal-once, regenerate, revoke) - a request sits as `pending` until
  someone with `approveApiKeys` approves it on the API Keys tab.
- **viewApiKeys** - see the full key list across every user (implied by
  `approveApiKeys` and `revokeApiKeys`).
- **approveApiKeys** - approve/deny pending key requests; their own key
  requests auto-approve instead of queuing.
- **revokeApiKeys** - revoke or bulk-revoke any user's key, not just their
  own.
- **manageScheduler** - *configure* the scheduler: watch/dispatch repos,
  workflow file, poll cron, notification webhook URL.
- **triggerDispatch** - *operate* the scheduler without being able to
  reconfigure it: manually trigger a check, preview the next dispatch,
  send a test webhook notification, dismiss App Store auth-failure
  alerts. Split from `manageScheduler` so an on-call operator can run
  things without also being able to repoint what they run against.
- **manageAppleAuth** - the Apple Auth sub-tab: runs the App Store
  re-authentication flow, which puts real Apple ID credentials through the
  pipeline. Its own dedicated permission rather than a side effect of
  another grant.
- **viewLogs** - the Logs tab: the live scheduler/job log feed.
- **viewUsers** - see the allowlist and everyone's permissions, read-only
  (implied by `manageUsers`).
- **manageUsers** - add/remove people from the allowlist and change their
  permissions. A user can't remove their own `manageUsers` - get another
  user with it to do that, or fall back to `ADMIN_PASSWORD`.

The Users tab is a compact allowlist table with an **Add user** button
that opens a modal, and a **Manage** button per row that opens the same
editor pre-filled - both modals cap their height and scroll internally
instead of growing with the permission count. Permissions are grouped
under small category headers with a name, one-line description, and a
toggle switch per row (no walls of always-expanded checkbox cards), plus
quick presets (Viewer / Member / Key manager / Ops admin / Admin) that
just flip the switches - any custom combination is still one edit away,
and implied permissions show as checked-and-locked so the list always
reflects what's actually granted.

Per-account preferences (currently just light/dark theme) are synced
server-side, not just `localStorage` - switching browsers or devices keeps
your last choice.

**Priority**: `manageUsers` can set a user's queue priority (-5 to 5,
default 0) from the Manage dialog on the Users tab, and `approveApiKeys` can
set a priority per API key from the API Keys tab's "All keys" table.
Higher-priority manually-queued jobs jump ahead of lower/default-priority
ones already waiting - useful for e.g. keeping a CI runner's key below an
on-call operator's own requests. It only reorders the manual queue; the
scheduler's own jobs are unaffected (they already always jump to the
front).

**Push notifications**: the bell/permissions dropdown has an "Enable"
button that requests browser notification permission and registers a Web
Push subscription (VAPID keys are generated once and persisted in
`STATE_DIR`) - once enabled, you get notified when your own queued decrypt
finishes or fails even with the dashboard tab (or the whole browser)
closed, not just while it's open in the foreground. Subscriptions are
per-browser; a stale/expired one is dropped automatically the next time a
push to it fails.

Tabs:

- **Home** - search the App Store and queue a decrypt, your own
  queued/finished requests, scheduler on/off, active jobs, recent history
  (searchable and exportable as CSV/JSON), the last 10 scheduler run
  outcomes, and a banner if a decrypt failure looked like an App Store
  auth issue.
  Each free result has a clock-icon button that opens its App Store
  version history and lets you decrypt an older release instead of the
  current one (`ipadecrypt decrypt --external-version-id`) - see
  **Decrypting a specific version** below. A finished job's **Share**
  button issues a one-time signed download link and also lists every link
  issued for that job so far (who issued it, when it expires) with a
  **Revoke** action to kill an active one early - revoking only affects
  that specific link, not the job itself.
- **API Keys** (needs `decrypt`, `viewApiKeys`, `approveApiKeys`, or
  `revokeApiKeys`) - request/reveal/regenerate/revoke your own keys, and
  optionally restrict a key to a comma-separated list of bundle IDs at
  creation time (e.g. for a CI runner that should only ever touch one
  app) - the `/v1/decrypt` and `/v1/jobs/*` endpoints reject any bundle ID
  outside that list with a 403. Anyone with `approveApiKeys` additionally
  sees pending requests (approve/deny, individually or in bulk), can
  create an auto-approved key directly, and can set a key's queue priority
  from the "All keys" table (see **Priority** above); anyone with
  `viewApiKeys` sees the full key list across every user (paginated);
  anyone with `revokeApiKeys` can revoke or bulk-revoke keys that aren't
  theirs. A pending request posts to `NOTIFY_WEBHOOK_URL` (if configured)
  so an approver doesn't have to keep checking the tab. Keys are stored
  hashed - the plaintext is only ever shown once, right after
  approval/regeneration. The root `API_KEY` from `.env` always works too,
  is unrestricted, isn't priority-weighted, and isn't managed here. Each
  key's Usage dialog breaks down which bundle IDs it's actually been used
  to decrypt, not just a daily request-count total - handy for auditing
  what an unrestricted key is really being used for.
- **Logs** (needs `viewLogs`) - a live feed of scheduler/job log lines,
  filterable by scope (all/scheduler/jobs), level (info/warning/error),
  and free-text search, with CSV/JSON export of whatever's currently
  filtered. Persisted to disk (`logs.json` in `STATE_DIR`) so a restart
  doesn't lose history.
- **Docs** - copy-pasteable curl examples for using an API key, filled in
  with this instance's actual `PUBLIC_BASE_URL`.
- **Settings** (needs `manageScheduler`, `triggerDispatch`,
  `manageAppleAuth`, `viewUsers`, or `manageUsers`) - sub-tabs shown
  depend on which you have:
  - *Scheduler* (`manageScheduler` and/or `triggerDispatch`) - edit the
    watch bundle ID, watch/dispatch repos, workflow file, poll cron, and
    notification webhook URL live, no restart needed, if you have
    `manageScheduler` (fields are read-only otherwise). The
    preview/trigger/test-webhook/dismiss-alert actions need
    `triggerDispatch` instead - an operator can have one without the
    other. `GH_TOKEN` and `API_KEY` stay env-only, not editable here.
  - *Users* (`viewUsers` or `manageUsers`) - the GitHub OAuth allowlist:
    `viewUsers` alone gets a read-only list plus the audit log below it
    (who added/updated/removed which user, and what changed);
    `manageUsers` additionally lets you add a username with a permission
    set, or open the Manage dialog on an existing entry to change their
    permissions, queue priority (see **Priority** above), or remove them.
    A user can't remove their own `manageUsers` permission, and no change
    is allowed that would leave the allowlist with zero `manageUsers`
    holders - get someone else with it to do that, or fall back to
    `ADMIN_PASSWORD`. The allowlist table also supports selecting several
    users at once and applying a permission preset to all of them in one
    go.
  - *Apple Auth* (`manageAppleAuth`) - re-runs just the App Store sign-in step of `ipadecrypt
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

**Health monitoring & alerts**: the Status card tracks iDevice reachability,
battery (percent/temperature/health), and iDevice storage over the last
24h, alongside the host's own staging disk usage. Each has a
`manageScheduler`-configurable webhook alert threshold (device offline,
battery hot/low, iDevice storage low, staging disk full) with hysteresis
(a few percent/degrees of dead-band before it'll re-arm) so it fires once
per incident instead of flapping. A separate alert
(`notifyOnTestFlightBridgeDown`) covers the tfauto SpringBoard bridge -
it only fires on a regression from a previously-confirmed-working state,
never for a setup that's never had tfauto installed at all (see
**TestFlight builds** below), so it stays silent for anyone not using
that companion tweak.

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
- The queue is in-memory (priority-ordered among manual jobs, otherwise
  FIFO) - restarting the container drops any in-flight/queued jobs (the
  physical device only supports one worker anyway, so this hasn't been
  built out further).
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
