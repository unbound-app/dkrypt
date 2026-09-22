# dkrypt

Self-hosted App Store and TestFlight decryption for jailbroken iPhone and iPad devices.

dkrypt provides a dashboard and API for:

- decrypting current or pinned App Store releases and TestFlight builds;
- keeping an indexed IPA library with authenticated downloads;
- scheduling watches and dispatching artifacts to GitHub Actions; and
- managing users, API keys, billing, device health, backups, and notifications.

## Quick start

1. Clone the repository and copy `.env.example` to `.env`.
2. Set `API_KEY`, `SESSION_SIGNING_SECRET`, `PUBLIC_BASE_URL`, and `ADMIN_PASSWORD`.
3. Pair the iPhone or iPad with the host over USB and make sure the host exposes its `usbmuxd` socket.
4. Put the SSH key for the device at `~/.ssh/id_ed25519` for the initial autoinstall install and recovery access.
5. Start the service:

   ```sh
   docker compose up -d
   ```

6. Open the dashboard, go to **Settings → Devices**, and choose **Find a device**.
7. Select the USB or Wi-Fi device and choose **Set up**. dkrypt saves the direct device connection, checks the prerequisites, and shows exactly what still needs attention.

Device registration does not require `.ipadecrypt`, `config.json`, or a device setup CLI command. Existing installations using the old connection file are migrated when the service starts and can be finished from the same dashboard flow.

Open `http://localhost:8080`, or put an HTTPS reverse proxy in front of it.

<details>
<summary>Device requirements</summary>

The device needs:

- a rootless jailbreak with ElleKit;
- the dkrypt `autoinstall` bridge;
- an Apple ID signed in to the App Store; and
- no device passcode.

TestFlight builds also require TestFlight to be signed in. The bridge package can be built and deployed with:

```sh
AUTOINSTALL_IDEVICE_TARGET=mobile@<device-ip> \
AUTOINSTALL_IDEVICE_KEY="$HOME/.ssh/id_ed25519" \
make autoinstall-deploy
```

OpenSSH is only needed to install or repair a missing package. Once `autoinstall` is installed and the device is paired over USB, dkrypt uses its authenticated device agent through USBMux for runtime commands, preflight, and the dashboard's **Recover** action. Wi-Fi-only devices continue to use the configured SSH connection.

The dashboard setup check verifies the device connection, iOS, the jailbreak, the device agent, and the bridge heartbeat. Install or repair any item marked **attention**, then run setup again. dkrypt does not require a separate IPA installer package or a device `.ipadecrypt` directory.

</details>

<details>
<summary>Public TestFlight links</summary>

Users with **Request TestFlight subscriptions** can submit canonical public links such as `https://testflight.apple.com/join/ABC123` from **Settings → TestFlight**. A manager with **Manage TestFlight subscriptions** can approve the request, or submit a link directly.

dkrypt verifies access independently on every enabled device. A link appears in search only after at least one device has verified it recently, and the build picker shows which eligible device will be used. Approving a link does not install every future build; choose and queue a build as usual.

Unsubscribing stops dkrypt automation and removes the app from enabled devices when possible. Apple-side tester membership may remain active because TestFlight does not expose a reliable leave operation through the device bridge.

</details>

<details>
<summary>USB and Wi-Fi discovery</summary>

The Compose stack includes `libimobiledevice` and `usbmuxd` tools and mounts `/var/run/usbmuxd` for USB discovery and the authenticated runtime agent. The host must be running `usbmuxd` and expose that socket to the container. Paired Wi-Fi devices are detected through usbmuxd; dkrypt also probes the local private network for reachable iOS SSH services.

If network scanning is restricted, set `DEVICE_DISCOVERY_HOSTS` to a comma-separated list of device addresses or set `DEVICE_DISCOVERY_SUBNETS` to the private CIDR ranges to scan. The dashboard's **Have the address already?** field is always available as a fallback.

</details>

<details>
<summary>Self-hosting notes</summary>

Docker Compose, Git, and GNU Make are required. Persistent state, device runtime data, and IPA artifacts are stored in named Docker volumes.

For OAuth, Stripe, or external webhooks, use an HTTPS `PUBLIC_BASE_URL`. Keep the bootstrap SSH private key outside the repository and never commit `.env` or temporary credentials.

To update a source checkout:

```sh
git pull --ff-only origin main
docker compose up -d --build
```

</details>

<details>
<summary>Stripe billing</summary>

Stripe Managed Payments handles hosted checkout and automatic tax. Configure the eligible product tax code and secret in Stripe Dashboard, then from `packages/dkrypt` run:

```sh
bun run stripe:seed
bun run stripe:webhook
bun run stripe:verify
```

Store the generated price IDs and webhook secret in the runtime environment. `stripe:verify` checks the configured key mode, recurring prices, tax code, checkout compatibility, webhook events, and signed endpoint reachability.

</details>

<details>
<summary>Crypto billing</summary>

Crypto billing is an optional second payment method alongside Stripe. It uses NOWPayments hosted invoices for USDC or USDT payments priced in EUR. Each verified payment grants 30 days of access; users renew with a new invoice. NOWPayments pays the configured merchant wallet, and dkrypt does not custody crypto or store wallet private keys.

Keep crypto disabled until the NOWPayments test flow is complete. Configure these runtime values when enabling it:

```text
CRYPTO_BILLING_ENABLED=true
CRYPTO_TAX_MODE=stripe-tax
CRYPTO_MANUAL_TAX_ALLOWED=false
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
NOWPAYMENTS_IPN_SECRET_PREVIOUS=
NOWPAYMENTS_API_BASE_URL=https://api.nowpayments.io/v1
NOWPAYMENTS_ENVIRONMENT=live
NOWPAYMENTS_SUPPORTED_ASSETS=USDC,USDT
NOWPAYMENTS_DEFAULT_ASSET=USDC
NOWPAYMENTS_PRICE_CURRENCY=EUR
STRIPE_TAX_CODE=txcd_...
```

Set the NOWPayments IPN destination to `https://<your-host>/v1/nowpayments/webhook` and keep the IPN secret private. Live crypto checkout remains unavailable until NOWPayments lists the selected currencies and Stripe Tax has an active live registration. Crypto payments are outside Stripe Managed Payments; Stripe Tax is used only to calculate and record the external tax transaction. `CRYPTO_TAX_MODE=manual` is only for explicitly authorized development or self-hosted operations and displays an operator warning.

</details>

<details>
<summary>API</summary>

API requests use `Authorization: Bearer <API_KEY>`. Dashboard downloads use the signed-in session.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/decrypt?bundleId=<id>` | Queue or join a decrypt. |
| `POST /v1/decrypts` | Queue a decrypt by release selector. |
| `GET /v1/jobs/:id` | Read job status. |
| `GET /v1/artifacts` | List IPA artifacts. |
| `GET /v1/artifacts/:id/file` | Download an IPA artifact. |
| `GET /v1/health` | Read service and device health. |
| `GET /v1/billing/subscriptions` | Read the manager billing ledger with the billing permission. |
| `GET /v1/billing/provider-status` | Read provider readiness with the billing-management permission. |

Repositories receiving scheduler dispatches need a `DKRYPT_API_KEY` Actions secret. Set `DKRYPT_BASE_URL` when the deployment uses a public host other than `https://ipa.dylib.dev`.

</details>

<details>
<summary>Repository and development</summary>

| Path | Purpose |
| --- | --- |
| `packages/dkrypt/` | Fastify API and Svelte dashboard |
| `packages/autoinstall/` | Theos tweak installed on the device |
| `scripts/autoinstall-release` | Build, install, verify, and roll back the tweak |

Run the local checks with:

```sh
make check
moon run dkrypt:check
```

Useful package commands:

```sh
cd packages/dkrypt
bun test
bun run typecheck
bun run typecheck:web
```

Pushes to `main` run the Moon check graph, build an immutable GHCR image, and deploy that exact image to the homelab runner. A failed health check rolls back to the previous image.

</details>
