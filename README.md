# dkrypt

Docker Compose service that wraps [londek/ipadecrypt](https://github.com/londek/ipadecrypt)
behind an authenticated HTTP API, run against one or more jailbroken iDevices
reachable over SSH from the host. Two jobs:

1. **On-demand decrypt** - `GET /v1/decrypt?bundleId=...` decrypts and
   returns any app by bundle ID.
2. **Automated release watch** - one or more *watches*, each on its own cron
   schedule, check whether the currently-live App Store version of a watched
   bundle ID already has a matching release in its app repo; if not, decrypt
   it, temporarily host the IPA, and fire a `repository_dispatch`
   (`ipa-update`) at that watch's build workflow with a signed, short-lived
   download URL. A watch records its outcome the moment the dispatch call
   itself succeeds - it doesn't block the next scheduled check on waiting
   for the build workflow to actually finish (which can take a while). It
   then tracks that workflow run in the background and patches the same
   history entry with the final status once it completes, so the Status
   card's recent checks go `dispatched → succeeded/failed` live instead of
   just sitting on "dispatched" until everything's done. See **Multiple
   watches** below for managing more than one.

Both paths share one priority-ordered job queue per registered device (see
**Multiple devices** below) - manually-queued jobs can carry a priority
weight (see **Priority** below), scheduler jobs always jump straight to the
front regardless. A single-device install (the default - nothing extra to
configure) behaves exactly as before: one shared queue, one worker.

A third path, **TestFlight builds**, lets you browse an app's beta trains,
install a specific build, and decrypt it (`ipadecrypt decrypt
--use-installed`) - see **TestFlight builds** below for the extra
device-side setup this needs. TestFlight installs always run against the
primary device, even in a multi-device pool - see **Multiple devices**.

## Setup

1. Jailbroken iDevice on the same network as this host, with OpenSSH,
   AppSync Unified, and appinst installed (see the
   [ipadecrypt README](https://github.com/londek/ipadecrypt#requirements)).
2. Copy `.env.example` to `.env` and fill it in. Required: `API_KEY`,
   `DOWNLOAD_SIGNING_SECRET`, `PUBLIC_BASE_URL`, `ADMIN_PASSWORD`. Fill in
   the `WATCH_*` / `GH_*` vars too if you want the automated side (leave
   them blank to disable it), configure `GITHUB_OAUTH_*` and/or
   `DISCORD_OAUTH_*` for user sign-in, and add the Paddle values for paid
   subscriptions.
3. Build the image:

   ```sh
   docker compose build
   ```

4. **Bootstrap ipadecrypt once, interactively** (App Store login + device
   SSH details - persisted under `IPADECRYPT_ROOT_DIR`, default
   `/root/.ipadecrypt`, itself inside the `appstore-config` volume). The
   `api` service has a fixed `container_name`, so if it's already running,
   `docker compose run` needs an explicit different name to avoid clashing
   with it:

   ```sh
   docker compose run --rm -it --name dkrypt-bootstrap api ipadecrypt bootstrap
   ```

5. Start the service:

   ```sh
   docker compose up -d
   ```

To add a second (or third...) physical device later, bootstrap it the same
way against a distinct root dir (`ipadecrypt --root-dir /data/devices/b
bootstrap`, run interactively, same as step 4) and register that root dir
from **Settings → Devices** - see **Multiple devices** below.

## SaaS authentication and billing

Create OAuth applications with these callbacks:

- GitHub: `<PUBLIC_BASE_URL>/v1/auth/github/callback`
- Discord: `<PUBLIC_BASE_URL>/v1/auth/discord/callback`

Set their client IDs and secrets in the root `.env`. The first successful
OAuth login automatically creates a viewer account.

The Paddle sandbox catalog is reproducible with:

```sh
cd api
bun run paddle:seed
```

The command uses `PADDLE_SANDBOX_API_KEY` or `PADDLE_API_KEY` from the shell
and prints the four product and price IDs plus a browser-safe client token.
The committed sandbox IDs are already listed in `.env.example`.

Use `PADDLE_ENV=production bun run paddle:seed` with
`PADDLE_LIVE_API_KEY` to create or verify the separate live catalog.

After deploying the webhook route at a public HTTPS URL, create or update its
Paddle notification destination:

```sh
cd api
PADDLE_ENV=production PADDLE_WEBHOOK_URL=https://ipa.dylib.dev/v1/paddle/webhook bun run paddle:webhook
```

Copy the returned `endpointSecretKey` to `PADDLE_WEBHOOK_SECRET` in the root
`.env`, then restart the service. Shell profile variables are available to
the setup scripts but are not automatically inherited by Docker Compose, so
the container still needs `PADDLE_API_KEY` in its env file.

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
- **Sign in with GitHub or Discord** - each OAuth provider is shown when its
  client ID and secret are configured. The first successful login creates a
  viewer account automatically. Viewer accounts cannot queue decrypts or
  create and use API keys until a Paddle subscription or an administrative
  role grants those capabilities.

The **Plans** tab offers four monthly EUR subscriptions:

- **Regular (€5)** - dashboard decrypts at standard priority.
- **Priority (€10)** - dashboard decrypts at high priority.
- **API (€15)** - dashboard decrypts and API keys at standard priority.
- **Priority API (€20)** - dashboard decrypts and API keys at high priority.

Paddle webhooks are the source of truth for access. Active, trialing, and
past-due subscriptions retain access; paused and canceled subscriptions do
not. A scheduled cancellation keeps access until Paddle changes the
subscription status to canceled.

Access is ten independent, additive permissions, enforced server-side (the
UI just hides what a user can't do). A newly-added user starts with none
of them - pure read-only - and gains capabilities one at a time as an
admin grants them, rather than picking from a fixed tier. A few imply
others (checking a stronger switch auto-checks the weaker one it needs):

- **decrypt** - queue dashboard decrypts and manage their own jobs.
- **API access** - create and use their own API keys (request, reveal-once,
  regenerate, revoke) - a request sits as `pending` until someone with
  `approveApiKeys` approves it on the API Keys tab, while paid API plans
  create keys immediately.
- **viewApiKeys** - see the full key list across every user (implied by
  `approveApiKeys` and `revokeApiKeys`).
- **approveApiKeys** - approve/deny pending key requests; their own key
  requests auto-approve instead of queuing.
- **revokeApiKeys** - revoke or bulk-revoke any user's key, not just their
  own.
- **manageScheduler** - *configure* the scheduler: watches (bundle ID,
  repo, workflow file, poll cron), notification webhook URL.
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
  - *Scheduler* (`manageScheduler` and/or `triggerDispatch`) - manage the
    watch list (see **Multiple watches** below) in a compact card, and a
    "Notifications & alerts" card summarizing the one webhook URL, which
    events post to it (including "every decrypt finishes", not just
    scheduled updates - one webhook, just more toggles, not a second URL to
    configure), retry/retention settings, and alert thresholds, with an
    **Edit** button opening the full form in a dialog - live, no restart
    needed, if you have `manageScheduler` (read-only otherwise). The
    per-watch preview/trigger actions and the test-webhook/dismiss-alert
    actions need `triggerDispatch` instead - an operator can have one
    without the other. `GH_TOKEN` and `API_KEY` stay env-only, not editable
    here. A "Recent webhook deliveries" panel below shows the last 10
    attempts with their event, target host, success/failure, and error if
    any.
  - *Devices* (`manageScheduler`) - manage the device pool (see **Multiple
    devices** below).
  - *Users* (`viewUsers` or `manageUsers`) - OAuth accounts and manually-added users:
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

## Multiple watches

**Settings → Scheduler → Watches** manages a list of independently-scheduled
watches, each with its own bundle ID, repo (releases are checked against
this repo, and it's also where the dispatch workflow lives - in practice
these were always the same repo, so there's just one field), workflow file,
and poll cron - add as many as you need. Each ticks entirely on its own
schedule (no shared global tick), and each is also always watched for new
TestFlight builds the same way the single legacy watch was (its numeric App
Store ID resolved automatically, no separate config). Two *enabled* watches
can't target the same bundle ID (a disabled one can, so you can keep an old
config around without it colliding).

Existing single-watch installs (the `WATCH_BUNDLE_ID` / `WATCH_APP_REPO` /
`GH_DISPATCH_REPO` / `GH_WORKFLOW_FILE` / `POLL_CRON` env vars) keep working
unmodified - they're treated as one implicit watch until you explicitly add
a watch of your own or edit that implicit one from the dashboard, at which
point it's materialized into a real, editable entry (preferring
`WATCH_APP_REPO`, falling back to `GH_DISPATCH_REPO`, for the merged repo
field). `GH_TOKEN` stays a single env-only credential shared by every watch
(it needs access to all of their repos).

## Multiple devices

**Settings → Devices** manages a pool of registered iDevices. Each device
needs to already be independently bootstrapped (`ipadecrypt --root-dir
<path> bootstrap`, interactively, per device - see **Setup** above) before
it can be registered; the dashboard only consumes an already-bootstrapped
root dir, it can't run the interactive App Store sign-in for you. App Store
decrypt jobs distribute across every *enabled* device (first idle device
takes the next queued job); TestFlight jobs always run on whichever device
is flagged **primary**, since a TestFlight install and its tfauto bridge are
tied to one specific physical device. Device health (reachability, battery,
temperature, storage) is tracked and alerted on per device; the alert
*thresholds* themselves (Settings → Scheduler) are global across the whole
pool. Existing single-device installs (`IPADECRYPT_ROOT_DIR`, default
`/root/.ipadecrypt`) keep working unmodified as an implicit primary device,
materialized into a real entry the same way an implicit watch is.

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
  FIFO) per device - restarting the container drops any in-flight/queued
  jobs.
- Version matching for the automated App Store watch compares the iTunes
  Lookup API `version` field against release tags in a watch's repo,
  normalizing a leading `v` (`v334.0` vs `334.0`). It looks for an *exact*
  match, not "newer than" - if your release tags diverge from the App
  Store version scheme this will need adjusting in `api/src/util/
  version.ts`.
- Each watch also always watches TestFlight for new builds of its own
  bundle ID (its numeric App Store ID is resolved automatically via the
  same iTunes lookup, no separate config), matching tags shaped
  `v{shortVersion}_{buildNumber}` (e.g. `v1.0.0_106191`) - a different,
  exact-string match against the *raw* tag name, not the normalized App
  Store comparison above. Fails silently (logged, not fatal) if `tfauto`
  isn't installed on the device - see **TestFlight builds**.
- Job history retention (Settings → Scheduler) defaults to keeping the most
  recent 100 entries indefinitely; setting a day count also purges anything
  older than that window on top of the count cap.
- Decrypted apps' `Info.plist` (bundle/short version, minimum OS,
  executable name, and the full primitive-valued key set) is captured at
  decrypt time and stored alongside that job's history entry - the Job
  History panel's bundle-stats view uses it to diff any two versions of the
  same app (size delta + changed plist keys) without needing the original
  files, which don't stick around past `FILE_TTL_MINUTES`.
