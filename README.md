# dkrypt

Self-hosted App Store and TestFlight decryption for jailbroken iPhone and iPad devices.

dkrypt provides an authenticated dashboard for managing decrypts, IPA artifacts, devices, automation, and billing, plus a narrow public API for decrypt workflows and IPA artifact access.

## Quick start

1. Clone the repository and copy `.env.example` to `.env`.
2. Set `API_KEY`, `SESSION_SIGNING_SECRET`, and `ADMIN_PASSWORD` to long random values.
3. Connect the iPhone or iPad over USB, unlock it, and accept the trust prompt.
4. Start dkrypt:

   ```sh
   docker compose up -d --build
   ```

5. Open `http://localhost:8080`, sign in, open **Settings → Devices**, select the discovered device, and choose **Set up**.

The setup flow pairs the device, verifies iOS and the jailbreak, checks ElleKit and autoinstall, and stores the device record. A device does not need an `.ipadecrypt` directory or a setup CLI command to be recognized.

## Requirements

- Docker Engine with Compose v2
- Linux host access to `/dev/bus/usb` for USB devices
- A rootless jailbreak with ElleKit
- The dkrypt autoinstall package installed on the device
- An App Store Apple ID; TestFlight jobs also need TestFlight access

The image contains the Rust device bridge, the pinned `idevice` revision, and the pinned `netmuxd` release. USB discovery, pairing, reconnects, and local service tunnels are owned by the bridge; the host does not need Apple device CLI tools or a mounted mux socket.

<details>
<summary>Initial device package installation</summary>

The dashboard manages pairing and readiness after autoinstall is present. Installing or repairing the package still needs an SSH-capable path once, because the package is the device-side execution layer.

```sh
AUTOINSTALL_IDEVICE_TARGET=mobile@<device-address> \
AUTOINSTALL_IDEVICE_KEY="$HOME/.ssh/id_ed25519" \
make autoinstall-deploy
```

After installation, reconnect the device over USB and finish **Settings → Devices → Set up**. The SSH key is not used as the USB discovery or recovery dependency. For USB decrypts, dkrypt opens a Rust-managed local service tunnel and only uses SSH credentials for the `ipadecrypt` compatibility channel.

</details>

<details>
<summary>Wi-Fi devices and recovery</summary>

Wi-Fi devices must already be paired and reachable on the host network. The Rust bridge uses the paired device transport and mDNS discovery; allow local multicast discovery when the host firewall or container network is restricted. USB devices remain discoverable and recoverable when device-side SSH or Wi-Fi is unavailable.

If the device is temporarily absent, dkrypt keeps the record and marks the affected subsystem as recovering or offline. It does not erase the device or enter maintenance mode solely because the SSH/SFTP channel needed by one decrypt is unavailable.

</details>

<details>
<summary>Self-hosting configuration</summary>

Copy `.env.example` to `.env` and configure the required values. The important runtime settings are:

| Setting | Purpose |
| --- | --- |
| `API_KEY` | API authentication and health checks |
| `SESSION_SIGNING_SECRET` | Dashboard session signing |
| `BACKUP_MANIFEST_SECRET` | Stable key for encrypted backup manifests; keep it independent from session rotation |
| `BACKUP_MANIFEST_SECRET_PREVIOUS` | Comma-separated previous manifest keys retained while older snapshots still exist |
| `ADMIN_PASSWORD` | Local administrator sign-in |
| `PUBLIC_BASE_URL` | Public origin for OAuth, webhooks, and secure cookies |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub sign-in application identifier |
| `GITHUB_OAUTH_CLIENT_SECRET` | Current GitHub sign-in secret |
| `GITHUB_OAUTH_CLIENT_SECRET_PREVIOUS` | Previous GitHub OAuth secret retained during a provider-supported rotation window |
| `DISCORD_OAUTH_CLIENT_ID` | Discord sign-in application identifier |
| `DISCORD_OAUTH_CLIENT_SECRET` | Current Discord sign-in secret |
| `DISCORD_OAUTH_CLIENT_SECRET_PREVIOUS` | Previous Discord OAuth secret retained during a provider-supported rotation window |
| `NOWPAYMENTS_API_KEY` | Current NOWPayments API credential |
| `NOWPAYMENTS_API_KEY_PREVIOUS` | Previous NOWPayments API key tried only after HTTP 401 from the current key |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP credentials and server used for optional email notifications |
| `SMTP_PASS_PREVIOUS` | Previous SMTP password used only after a permanent authentication rejection |
| `OUTBOUND_WEBHOOK_SECRET` | HMAC key for signing outgoing notification webhooks |
| `OUTBOUND_WEBHOOK_SECRET_PREVIOUS` | Previous HMAC key used during outbound webhook key rotation |
| `DEVICE_SSH_KEY_PATH` | Runtime path to the key used only by the `ipadecrypt` compatibility channel |
| `DEVICE_SSH_KEY_HOST_PATH` | Host key copied read-only into the container runtime directory |
| `ARTIFACT_DIR` | IPA storage volume |
| `STATE_DIR` | SQLite database, pairing material, backups, and mirrors |

The Bun API runs as an unprivileged service account; the USB bridge retains root access for direct device transport, with a small root supervisor managing both processes. Startup migrates existing state and artifact volume permissions once, keeps pairing records root-only, and exposes the SSH key to the API through a read-only group-readable copy in tmpfs. Keep `.env`, pairing material, and SSH private keys out of Git. Use an HTTPS reverse proxy when exposing the dashboard beyond localhost.

Outgoing notification webhooks include `X-Dkrypt-Event`, `X-Dkrypt-Timestamp`, and `X-Dkrypt-Signature`. The signature is `sha256=` followed by the HMAC-SHA256 hex digest of `<timestamp>.<raw JSON body>`. During rotation, set `OUTBOUND_WEBHOOK_SECRET` to the new key and `OUTBOUND_WEBHOOK_SECRET_PREVIOUS` to the old key; dkrypt sends the old-key signature in `X-Dkrypt-Signature-Previous` over the same timestamp and body. Configure receivers to accept either signature, reject stale timestamps, and compare signatures in constant time. Remove the previous key after every receiver accepts the current key.

For SMTP rotation, set `SMTP_PASS` to the new password and `SMTP_PASS_PREVIOUS` to the old one. Email delivery tries the previous password only when the server definitively rejects the current password with SMTP 535; network and temporary SMTP failures are not retried with another credential. Successful fallback is logged without including either password. Remove the previous password after confirming current-credential delivery. GitHub and Discord OAuth callbacks similarly try their previous client secret only for the provider's explicit invalid-client-secret response, never for an invalid authorization code or network error. Keep previous OAuth secrets only while the provider still accepts them; some providers invalidate a secret immediately when it is regenerated.

For NOWPayments API-key rotation, set `NOWPAYMENTS_API_KEY` to the new key and `NOWPAYMENTS_API_KEY_PREVIOUS` to the old key during the overlap window. dkrypt retries with the previous key only after an HTTP 401; permission, server, and network failures are not retried with another credential. Successful fallback is logged without exposing either key. Remove the previous key after confirming requests use the current credential.

The SQLite database uses WAL mode, foreign keys, migration checksums, integrity checks, and an atomic pre-migration backup. Startup fails closed when the database or migration checksums are invalid. The dashboard doctor is available to managers at `/v1/dashboard/doctor`.

To update a source checkout:

```sh
git pull --ff-only origin main
docker compose up -d --build
```

</details>

<details>
<summary>OpenTelemetry export</summary>

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector base URL to send traces and metrics to its `/v1/traces` and `/v1/metrics` paths. Signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` values are sent to exactly the URLs provided. Configure shared or signal-specific authorization headers with the matching `OTEL_EXPORTER_OTLP_*_HEADERS` variables as comma-separated `name=value` pairs. Device reconnect metrics come from the Rust bridge's native usbmuxd attach/detach events; `device_bridge_event_stream_connected` reports whether that event feed is live.

dkrypt sends OTLP over HTTP using JSON encoding. Exported metrics include job queue and decrypt duration, device availability and reconnects, bridge and agent health, TestFlight lookup performance, artifact and device storage pressure, and webhook reconciliation. The internal `GET /v1/metrics` endpoint provides Prometheus text format to dkrypt's service credential and is unavailable to generated API keys.

</details>

<details>
<summary>Backups and restore checks</summary>

Backups include the legacy export, a verified SQLite copy, and an encrypted checksum manifest. Set a stable `BACKUP_MANIFEST_SECRET` so session-secret rotation does not invalidate snapshots. When rotating the manifest secret, keep the old value in `BACKUP_MANIFEST_SECRET_PREVIOUS` until every snapshot encrypted with it has expired or been removed. The backup scheduler can be configured in the dashboard. A restore drill opens the SQLite copy in a temporary database and verifies its integrity, schema migration checksums, state snapshot, and manifest hashes before it is reported healthy.

Do not copy database files while the service is running. Use the dashboard backup action or stop the service before making an external volume snapshot.

</details>

<details>
<summary>Stripe billing</summary>

Stripe remains the card and bank payment path. Configure the live Stripe secret, recurring price IDs, webhook secret, and tax settings in the runtime environment. Stripe readiness is visible in the manager billing view and the configuration doctor.

</details>

<details>
<summary>Crypto billing</summary>

Crypto billing is an optional second payment method using NOWPayments hosted invoices. It supports the configured EUR plans and selected crypto assets without custody or private-key storage in dkrypt. Crypto checkout does not ask for Stripe billing-address data.

Keep it disabled until the provider dashboard, wallet, IPN secret, webhook URL, and settlement settings are ready:

```text
CRYPTO_BILLING_ENABLED=true
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
NOWPAYMENTS_API_BASE_URL=https://api.nowpayments.io/v1
NOWPAYMENTS_ENVIRONMENT=live
NOWPAYMENTS_SUPPORTED_ASSETS=USDC,USDT
NOWPAYMENTS_DEFAULT_ASSET=USDC
NOWPAYMENTS_PRICE_CURRENCY=EUR
```

Set the IPN destination to `https://<your-host>/v1/nowpayments/webhook`. The provider webhook is durable, deduplicated, and replayable by managers. Crypto payments have provider-specific refund and tax handling; they do not inherit Stripe Managed Payments or Stripe merchant-of-record treatment.

</details>

<details>
<summary>API</summary>

Public API requests use `Authorization: Bearer <API_KEY>` and cover decrypt workflows and IPA artifacts only. Dashboard requests use the signed-in session.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/decrypt` | Request a decrypt and stream the completed IPA |
| `POST /v1/decrypts` | Queue a decrypt by release selector |
| `POST /v1/testflight/decrypt` | Queue a TestFlight build decrypt |
| `GET /v1/testflight/:appId/trains` | List TestFlight trains for a decrypt workflow |
| `GET /v1/testflight/:appId/builds` | List TestFlight builds for a decrypt workflow |
| `GET /v1/jobs/:id` | Read job status, attempts, deadline, warnings, and transport evidence |
| `GET /v1/artifacts` | List IPA artifacts |
| `GET /v1/artifacts/:id` | Read IPA artifact metadata |
| `GET /v1/artifacts/:id/file` | Download an IPA artifact |

Dashboard, billing, account, session, health, and administration routes are internal to dkrypt and are not available to generated API keys. The public OpenAPI document is available at `/openapi.json` and the Scalar reference UI at `/reference`.

</details>

<details>
<summary>Development and deployment</summary>

```sh
cd packages/dkrypt
bun install --frozen-lockfile
bun test
bun run typecheck
bun run typecheck:web
cd ../device-bridge
cargo test --locked
cargo check --locked
```

The deployment workflow runs the Bun and Rust checks, builds an immutable GHCR image, starts the bridge with direct USB access, waits for database integrity and health, and rolls back to the previous image if readiness fails. The Rust bridge is cut over immediately after those gates; runtime fallback to the old C toolchain is not part of the production configuration.

</details>

## License

See the repository license files.
