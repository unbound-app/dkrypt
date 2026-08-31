# dkrypt

dkrypt is a self-hosted dashboard and API for headlessly decrypting App Store and TestFlight apps on a jailbroken iPhone or iPad.

<img width="1822" height="1095" alt="ishare-1788189848-zen" src="https://github.com/user-attachments/assets/2c0e65cd-92b8-4653-8d21-3ee87c4e8171" />

## What it does

- Decrypts current or pinned historical App Store releases by bundle ID.
- Browses and decrypts TestFlight builds.
- Queues jobs and keeps a persistent indexed IPA library with authenticated artifact downloads.
- Watches App Store releases on a schedule and dispatches authenticated artifact URLs to GitHub Actions.
- Protects scheduled watches from exhausting the GitHub API budget and shows their next 24 hours of runs.
- Runs a multi-user dashboard with OAuth, API keys, roles, billing, device health, logs, and backups.
- Gives admins per-user job, key, API-usage, and last-activity visibility.

## Requirements

- Docker Compose
- A jailbroken iPhone or iPad reachable over SSH
- [autoinstall](packages/autoinstall/README.md), installed on the device
- An Apple ID signed in to App Store on the device; TestFlight sign-in is needed only for beta builds

## Quick start

1. Copy `.env.example` to `.env` and set at least `API_KEY`, `SESSION_SIGNING_SECRET`, `PUBLIC_BASE_URL`, and `ADMIN_PASSWORD`.
2. Build the service:

   ```sh
   docker compose build
   ```

3. Install or update autoinstall on the device:

   ```sh
   make autoinstall-deploy
   ```

4. Ensure the device connection directory configured by `IPADECRYPT_ROOT_DIR`
   (default `/root/.ipadecrypt`) contains a `config.json` with the device host,
   port, SSH user, and key path. Additional device connection directories can be
   registered from **Settings → Devices**.

5. Start dkrypt:

   ```sh
   docker compose up -d
   ```

Open `http://localhost:8080`, or place your reverse proxy in front of it.

<details>
<summary>Self-hosting setup</summary>

### Prepare the host

Install Docker Compose, GNU make, and Git. Clone this repository, copy <code>.env.example</code> to <code>.env</code>, and set <code>API_KEY</code>, <code>SESSION_SIGNING_SECRET</code>, <code>PUBLIC_BASE_URL</code>, and <code>ADMIN_PASSWORD</code> to values for your deployment. Use an HTTPS <code>PUBLIC_BASE_URL</code> when enabling OAuth, Stripe, or external webhooks.

Keep the host's SSH private key outside the repository. Compose mounts <code>$HOME/.ssh/id_ed25519_ipad</code> into the container as <code>/root/.ssh/id_ed25519</code>; create that file or update the SSH-key volume in <code>docker-compose.yml</code> to match your key.

### Prepare the device

The device needs a rootless jailbreak with ElleKit, OpenSSH, AppSync Unified, appinst, and no passcode. Sign in to the App Store on the device; TestFlight builds also require TestFlight to be signed in. Verify SSH access from the host before continuing:

~~~sh
ssh -i "$HOME/.ssh/id_ed25519_ipad" mobile@<device-ip> 'uname -a'
~~~

Install the autoinstall bridge from the repository root. Override the target and key when they differ from the defaults:

~~~sh
AUTOINSTALL_IPAD_TARGET=mobile@<device-ip> AUTOINSTALL_IPAD_KEY="$HOME/.ssh/id_ed25519_ipad" make autoinstall-deploy
~~~

The release script builds the tweak, installs it, restarts the affected processes, checks the bridge heartbeat, and rolls back when verification fails.

### Configure the device connection

Autoinstall handles on-device App Store and TestFlight installs. dkrypt still needs a small SSH connection file so it can reach the device and run the final decrypt. Create a temporary <code>device-config.json</code> with the connection details:

~~~json
{
  "device": {
    "host": "<device-ip>",
    "port": 22,
    "user": "mobile",
    "auth": {
      "keyPath": "/root/.ssh/id_ed25519"
    }
  }
}
~~~

Start the service, then copy the file into the persistent Compose volume:

~~~sh
docker compose up -d
docker compose cp device-config.json api:/root/.ipadecrypt/config.json
~~~

The default connection directory is <code>/root/.ipadecrypt</code>. Change it
with <code>IPADECRYPT_ROOT_DIR</code> if needed, and add a persistent Compose
volume mount for the replacement path. For additional devices, create a
separate directory under that persistent volume, copy a connection file there,
and register the directory in **Settings → Devices**:

~~~sh
docker compose exec api mkdir -p /root/.ipadecrypt/devices/device-b
docker compose cp device-b-config.json api:/root/.ipadecrypt/devices/device-b/config.json
~~~

The key path in each connection file is the path inside the container, not the host path. Do not commit the temporary JSON files or put private-key contents in them.

### Verify the installation

The API health response should report a reachable device, a reachable autoinstall bridge, and <code>readiness: "ready"</code>:

~~~sh
docker compose exec api bun -e 'const response = await fetch("http://127.0.0.1:8080/v1/health", { headers: { authorization: "Bearer " + process.env.API_KEY } }); console.log(await response.text()); process.exit(response.ok ? 0 : 1)'
~~~

If the device is unreachable, test SSH from inside the API container and confirm that the mounted key path and the <code>config.json</code> host, port, and user are correct. If the bridge is not ready, confirm that autoinstall is installed and that the App Store account is signed in without a device passcode.

### Update safely

Persistent state, connection configuration, and decrypted artifacts live in Docker volumes. To update a source-based installation, pull the new revision, rebuild, and recreate the service:

~~~sh
git pull --ff-only origin main
docker compose build
docker compose up -d
~~~

</details>

## Deployment

Pushes to `main` run the Moon check graph, generate the dashboard changelog from Git history, publish an immutable GHCR image, and deploy that exact digest on the homelab runner. The runner keeps only the runtime `.env` in `/home/adrian/.local/share/dkrypt`, pulls images, and never retains a source checkout. If its health check fails, it starts the previous image again.

The homelab runtime `.env` must include `SESSION_SIGNING_SECRET` alongside the other required authentication values.

## Stripe setup

Enable Managed Payments and accept its terms in Stripe Dashboard first. Then choose an eligible product tax code for dkrypt’s SaaS plans and set `STRIPE_TAX_CODE` before creating the monthly EUR catalog and hosted webhook from `packages/dkrypt` with a Stripe test or live secret:

```sh
bun run stripe:seed
bun run stripe:webhook
bun run stripe:verify
```

Copy the four price IDs printed by `stripe:seed` into the runtime environment, store the webhook secret printed for a newly created endpoint as `STRIPE_WEBHOOK_SECRET`, and set `STRIPE_WEBHOOK_URL` to the public `/v1/stripe/webhook` URL. `stripe:verify` checks the configured key mode, recurring price amounts, eligible product tax codes, Managed Payments Checkout compatibility, webhook URL, subscribed events, and signed endpoint reachability without printing any secret. Its Checkout probe is created and immediately expired without collecting payment details.

## API

The listed API endpoints use `Authorization: Bearer <API_KEY>`. Dashboard downloads use the signed-in session, while API and scheduler downloads use `Authorization: Bearer <API_KEY>`. Artifact URLs remain valid until the underlying artifact is explicitly removed or evicted by storage quota.

Repositories receiving scheduler dispatches must define a `DKRYPT_API_KEY` Actions secret. The loader’s remote-deploy workflow enables authenticated artifact-source downloads with that secret; manual and other external IPA source downloads remain unauthenticated. For a deployment whose `PUBLIC_BASE_URL` is not `https://ipa.dylib.dev`, set the receiving repository variable `DKRYPT_BASE_URL` to the same host.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/decrypt?bundleId=<id>` | Queue or join a decrypt and return the IPA. |
| `GET /v1/decrypt?bundleId=<id>&externalVersionId=<id>` | Decrypt a pinned historical App Store release. |
| `POST /v1/decrypts` | Queue or reuse a decrypt by release selector (`240`, `234.2`, or `240_109440`). |
| `GET /v1/jobs/:id` | Read job status. |
| `GET /v1/artifacts` | List IPA artifacts. |
| `GET /v1/artifacts/:id/file` | Download an IPA artifact with an API key. |
| `GET /v1/health` | Read liveness and scheduler state. |

The `POST /v1/decrypts` selector accepts an optional leading `v`. A blank selector resolves the current App Store version and lets the signed-in device's autoinstall bridge perform the install. Historical App Store selectors use the available version history when an external version id is known; selectors containing an underscore target a TestFlight train and build. Completed artifacts survive job-history cleanup and remain available until the persistent artifact store reaches its configured 200 GiB limit; least-recently-used artifacts are evicted first.

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
