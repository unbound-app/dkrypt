# dkrypt

dkrypt is a self-hosted dashboard and API for headlessly decrypting App Store and TestFlight apps on a jailbroken iPhone or iPad.

It uses the device's signed-in App Store account and `ipadecrypt`; no Apple ID is configured in dkrypt.

## What it does

- Decrypts current or pinned historical App Store releases by bundle ID.
- Browses and decrypts TestFlight builds.
- Queues jobs, keeps a downloadable history, and creates expiring share links.
- Watches App Store releases on a schedule and dispatches signed IPA URLs to GitHub Actions.
- Protects scheduled watches from exhausting the GitHub API budget and shows their next 24 hours of runs.
- Runs a multi-user dashboard with OAuth, API keys, roles, billing, device health, logs, and backups.
- Gives admins per-user job, key, API-usage, and last-activity visibility.

## Requirements

- Docker Compose
- A jailbroken iPhone or iPad reachable over SSH
- `ipadecrypt` prerequisites on the device
- [autoinstall](packages/autoinstall/README.md), installed on the device
- An Apple ID signed in to App Store on the device; TestFlight sign-in is needed only for beta builds

## Quick start

1. Copy `.env.example` to `.env` and set at least `API_KEY`, `DOWNLOAD_SIGNING_SECRET`, `PUBLIC_BASE_URL`, and `ADMIN_PASSWORD`.
2. Build the service:

   ```sh
   docker compose build
   ```

3. Configure the device SSH connection once:

   ```sh
   docker compose run --rm -it --name dkrypt-bootstrap api ipadecrypt bootstrap
   ```

4. Start dkrypt:

   ```sh
   docker compose up -d
   ```

Open `http://localhost:8080`, or place your reverse proxy in front of it.

## Deployment

Pushes to `main` run the Moon check graph, generate the dashboard changelog from Git history, publish an immutable GHCR image, and deploy that exact digest on the homelab runner. The runner keeps only the runtime `.env` in `/home/adrian/.local/share/dkrypt`, pulls images, and never retains a source checkout. If its health check fails, it starts the previous image again.

## Stripe setup

Enable Managed Payments and accept its terms in Stripe Dashboard first. Then choose an eligible product tax code for dkrypt’s SaaS plans and set `STRIPE_TAX_CODE` before creating the monthly EUR catalog and hosted webhook from `packages/dkrypt` with a Stripe test or live secret:

```sh
bun run stripe:seed
bun run stripe:webhook
bun run stripe:verify
```

Copy the four price IDs printed by `stripe:seed` into the runtime environment, store the webhook secret printed for a newly created endpoint as `STRIPE_WEBHOOK_SECRET`, and set `STRIPE_WEBHOOK_URL` to the public `/v1/stripe/webhook` URL. `stripe:verify` checks the configured key mode, recurring price amounts, eligible product tax codes, Managed Payments Checkout compatibility, webhook URL, subscribed events, and signed endpoint reachability without printing any secret. Its Checkout probe is created and immediately expired without collecting payment details.

## API

The listed API endpoints use `Authorization: Bearer <API_KEY>`. Completed IPA downloads may also use an expiring signed share token.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/decrypt?bundleId=<id>` | Queue or join a decrypt and return the IPA. |
| `GET /v1/decrypt?bundleId=<id>&externalVersionId=<id>` | Decrypt a pinned historical App Store release. |
| `GET /v1/jobs/:id` | Read job status. |
| `GET /v1/jobs/:id/file` | Download a completed IPA. |
| `GET /v1/health` | Read liveness and scheduler state. |

## Monorepo

| Path | Purpose |
| --- | --- |
| `packages/dkrypt/` | Fastify API and Svelte dashboard |
| `packages/autoinstall/` | Theos tweak installed on the device |
| `scripts/autoinstall-release` | Build, install, heartbeat-check, and roll back the tweak |

Moon manages the cross-language project graph and task targets. The `Makefile` remains a short convenience layer.
Moon is pinned in `.prototools`; install it with `proto install` before using the Moon commands.

| Moon project | Scope |
| --- | --- |
| `dkrypt` | Fastify API tests, dashboard checks, Compose build, and release tasks |
| `web` | Svelte dashboard type checks |
| `autoinstall` | Theos package and deployment tasks |

```sh
make check
make autoinstall-package
make autoinstall-deploy
make autoinstall-rollback PACKAGE=/absolute/path/to/package.deb
moon run dkrypt:check
moon run autoinstall:package
```

`autoinstall-deploy` uses the configured device target. Override the target or SSH key with `AUTOINSTALL_IPAD_TARGET` and `AUTOINSTALL_IPAD_KEY`.

## Development

```sh
cd packages/dkrypt
bun test
bun run typecheck
bun run typecheck:web
```

For scheduler watches, OAuth, Stripe, push notifications, and all optional integrations, use the documented environment variables in `.env.example` and configure them from the dashboard. Existing billing records from the previous provider are retained as legacy records and do not grant Stripe entitlements; review affected accounts before creating new Stripe subscriptions.
