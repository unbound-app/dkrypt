# autoinstall

The dkrypt device-side tweak for headless App Store and TestFlight installs on jailbroken iOS.

It injects into SpringBoard, TestFlight, App Store, and PassbookUIService to launch apps with the screen dark, request installs through the device's already-signed-in account, and confirm the App Store install sheet without a tap.

## Requirements

- Rootless jailbreak with ElleKit
- Theos
- An Apple ID signed in to App Store and TestFlight
- No device passcode

## Build

```sh
gmake clean package
```

The package is written to `packages/dev.adrian.autoinstall_<version>_iphoneos-arm64.deb`.

From the repository root, use the release rail to build, install, restart SpringBoard, check the heartbeat, and roll back when possible:

```sh
make autoinstall-deploy
```

## Bridge

dkrypt communicates through authenticated, per-operation files under `/tmp/autoinstall/v1`.

| Channel | Capabilities |
| --- | --- |
| SpringBoard | App launch, dark display mode, screen status |
| TestFlight | Trains, builds, installs, diagnostics |
| App Store | Current and pinned-version installs, diagnostics |

Each response carries the request ID. Transactions and heartbeat files are persisted per channel so dkrypt can recover safely after interruptions.

## Safety

The tweak only automates installs using the Apple ID already present on the device. dkrypt never receives Apple credentials. Keep the device on a trusted network and restrict SSH access.
