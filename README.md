# dkrypt

Self-hosted App Store and TestFlight decryption for jailbroken iPhone and iPad devices.

dkrypt provides an authenticated dashboard and API for decrypting releases, retaining IPA artifacts, scheduling watches, dispatching updates, managing devices, and administering billing.

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
| `SESSION_SIGNING_SECRET` | Dashboard sessions and backup manifest encryption |
| `ADMIN_PASSWORD` | Local administrator sign-in |
| `PUBLIC_BASE_URL` | Public origin for OAuth, webhooks, and secure cookies |
| `DEVICE_SSH_KEY_PATH` | Key used only by the `ipadecrypt` compatibility channel |
| `DEVICE_SSH_KEY_HOST_PATH` | Host path mounted at `DEVICE_SSH_KEY_PATH`; use your own key path |
| `ARTIFACT_DIR` | IPA storage volume |
| `STATE_DIR` | SQLite database, pairing material, backups, and mirrors |

State and artifact data live in Docker volumes. Keep `.env`, pairing material, and SSH private keys out of Git. Use an HTTPS reverse proxy when exposing the dashboard beyond localhost.

The SQLite database uses WAL mode, foreign keys, migration checksums, integrity checks, and an atomic pre-migration backup. Startup fails closed when the database or migration checksums are invalid. The dashboard doctor is available to managers at `/v1/dashboard/doctor`.

To update a source checkout:

```sh
git pull --ff-only origin main
docker compose up -d --build
```

</details>

<details>
<summary>Backups and restore checks</summary>

Backups include the legacy export, a verified SQLite copy, and an encrypted checksum manifest. The backup scheduler can be configured in the dashboard. A restore drill opens the SQLite copy in a temporary database and verifies its integrity, schema migration checksums, state snapshot, and manifest hashes before it is reported healthy.

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

API requests use `Authorization: Bearer <API_KEY>`. Dashboard downloads use the signed-in session.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/health` | Service, database, and primary-device health |
| `POST /v1/decrypts` | Queue a decrypt by release selector |
| `GET /v1/jobs/:id` | Read job status, attempts, deadline, warnings, and transport evidence |
| `GET /v1/artifacts` | List IPA artifacts |
| `GET /v1/artifacts/:id/file` | Download an IPA artifact |
| `GET /v1/billing/subscriptions` | Manager subscription ledger and filters |
| `GET /v1/billing/provider-status` | Manager provider readiness |

OpenAPI is available at `/openapi.json` and the Scalar reference UI at `/reference`.

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
