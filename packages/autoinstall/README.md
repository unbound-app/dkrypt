# autoinstall

The dkrypt device-side tweak for headless App Store and TestFlight installs on jailbroken iOS.

It injects into SpringBoard, TestFlight, App Store, and PassbookUIService to launch apps with the screen dark, request installs through the device's already-signed-in account, and confirm the App Store install sheet without a tap.

## Device requirements

- Rootless jailbreak with ElleKit
- An Apple ID signed in to App Store and TestFlight
- No device passcode

OpenSSH is only needed for the initial package install or recovery. After installation, dkrypt reaches the device through the authenticated loopback agent on the USBMux connection. The agent is not exposed on the device network. Wi-Fi-only connections still use OpenSSH.

## Build

The build host needs Theos.

```sh
gmake clean package
```

The package is written to `packages/dev.adrian.autoinstall_<version>_iphoneos-arm64.deb`.

From the repository root, use the release rail to build, install, restart SpringBoard, check the heartbeat, and roll back when possible:

```sh
make autoinstall-deploy
moon run autoinstall:package
```

## Device agent

The package includes `autoinstall-device-agent`, a launch daemon that listens on `127.0.0.1:5913`. dkrypt forwards that port over the paired USBMux connection. The first connection bootstraps the per-device secret; all later requests use signed, replay-limited frames and can execute the existing bridge commands without opening a new SSH session.

## Bridge

dkrypt communicates through authenticated, per-operation files under `/tmp/autoinstall/v1`.

| Channel | Capabilities |
| --- | --- |
| SpringBoard | App launch, dark display mode, screen status |
| TestFlight | Trains, builds, installs, diagnostics |
| App Store | Current and pinned-version installs, diagnostics |

Each response carries the request ID. Transactions and heartbeat files are persisted per channel so dkrypt can recover safely after interruptions.

## Safety

The tweak only automates installs using the Apple ID already present on the device. dkrypt never receives Apple credentials. Keep the pairing host trusted and keep OpenSSH restricted when it is enabled for bootstrap or Wi-Fi access.
