# autoinstall

A [Theos](https://theos.dev) tweak that lets [dkrypt](https://github.com/unbound-app/dkrypt) browse, install, and decrypt TestFlight builds — and, eventually, regular App Store builds too — on a jailbroken iOS device with zero human interaction, including with the display off. The App Store side lets dkrypt stop depending on `ipadecrypt`'s own Apple ID login (see the project notes for why that's currently unreliable) by driving the same on-device, already-authenticated purchase pipeline the real App Store app uses.

It injects into three processes from a single package:

- **`com.apple.TestFlight`** — hooks TestFlight's own private classes to list beta trains/builds via its internal REST API, and to drive a real install through its own installer, all over a file-based SSH bridge.
- **`com.apple.springboard`** — launches TestFlight (or the App Store) on demand via the private `SBSLaunchApplicationWithIdentifier` SPI (bypassing the fact that a display-off device otherwise refuses foreground launches through normal channels like `uiopen`), and exposes an SSH-toggleable "dark mode" that keeps the panel electrically on but at zero brightness — enough for SpringBoard to permit launches, without ever lighting up the screen.
- **`com.apple.AppStore`** — currently probe-only (see below): confirms `SKUIItemStateCenter`/`SKUIItem`/`SKUIItemOffer`/`SKUIClientContext` (StoreKitUI's private purchase pipeline, the same one [MuffinStore](https://github.com/mineek/MuffinStore) drives) still exist with matching methods on this iOS version, before a real install-driving hook gets built here the same way TestFlight's was.

## Requirements

- A rootless jailbreak with ElleKit (tested on palera1n, iOS 18.3.2).
- [Theos](https://theos.dev) to build.
- No passcode on the device. The dark-launch mechanism relies on SBS's launch-permission check keying off backlight/display power state, not lock-screen security — it hasn't been evaluated against a passcode-locked device.

## Building

```
gmake clean package
```

Produces `packages/dev.adrian.autoinstall_<version>_iphoneos-arm64.deb`. Install with `dpkg -i` and respring (`sbreload`, not a full reboot — see below).

## The bridge protocol

Both sides poll a request file every 200ms, write a response file, and delete the request file once handled. All requests are `{"action": "...", ...}` JSON; responses always include `"ok": true|false`.

### SpringBoard side (`/tmp/autoinstall-sb-request.json` → `/tmp/autoinstall-sb-response.json`)

| Action | Purpose |
| --- | --- |
| `dark_on` | Persist dark mode (survives respring) + apply it immediately (`preventIdleSleep` + `DisplayBrightnessFactor=0`). |
| `dark_off` | Clear the persisted flag and restore normal brightness/idle-sleep behavior. |
| `launch_app` (`bundleId`) | Re-applies dark mode if enabled, then SBS-launches the given bundle ID. This is the entry point dkrypt uses to bring TestFlight up. |
| `screen_status` / `status` | Reports `darkEnabled`, `screenIsOn`, `screenIsDim`, `backlightState`. |

### TestFlight side (`/tmp/autoinstall-request.json` → `/tmp/autoinstall-response.json`)

| Action | Purpose |
| --- | --- |
| `list_trains` (`appId`) | Lists beta trains (version groups) for an app. |
| `list_builds` (`appId`, `trainVersion`) | Lists builds within a train. |
| `install` (`appId`, `build`) | Reconstructs the build via TestFlight's own model classes and drives a real install through the live `TFAppInstaller`. Only signals the request was *accepted* — poll the installed bundle's `Info.plist` for actual completion. |
| `status` | Reports whether the installer/catalog manager are live, and current background-execution time remaining. |
| `end_background_keepalive` | Releases the background-task assertion taken out during `install`. |
| `probe` (`class`) / `probe_live` (`target`) | Runtime-introspection helpers (dump a class's method list, or describe whichever object is currently stashed) — used during development to find the right private API to call next. Safe to leave in; they're read-only. |

### App Store side (`/tmp/autoinstall-as-request.json` → `/tmp/autoinstall-as-response.json`) — probe-only for now

| Action | Purpose |
| --- | --- |
| `probe_skui` | Reports whether `SKUIItemStateCenter`/`SKUIItem`/`SKUIItemOffer`/`SKUIClientContext` exist and respond to the selectors an install would need (`defaultCenter`, `_newPurchasesWithItems:`, `_performPurchases:hasBundlePurchase:withClientContext:completionBlock:`, `initWithLookupDictionary:`, `defaultContext`). Read-only — doesn't call any of them yet. |

No `install` action exists on this side yet. Once the probe confirms the API surface is intact, the real call chain (adapted from MuffinStore, no hooking required since `SKUIItemStateCenter defaultCenter` is a plain class-method singleton) is:

```objc
SKUIItemOffer *offer = [[SKUIItemOffer alloc] initWithLookupDictionary:@{@"buyParams": offerString}];
SKUIItem *item = [[SKUIItem alloc] initWithLookupDictionary:@{@"_itemOffer": adamId}];
[item setValue:offer forKey:@"_itemOffer"];
[item setValue:@"iosSoftware" forKey:@"_itemKindString"];
// [item setValue:@(versionId) forKey:@"_versionIdentifier"]; // optional, pins a historical version
SKUIItemStateCenter *center = [SKUIItemStateCenter defaultCenter];
[center _performPurchases:[center _newPurchasesWithItems:@[item]] hasBundlePurchase:0
        withClientContext:[SKUIClientContext defaultContext] completionBlock:^(id arg1){ ... }];
```

## Why this exists instead of a standalone CLI tool

An earlier iteration (`sbslaunch`) was a separate signed root binary that called the same private APIs directly. It turned out to be unnecessary: SpringBoard already holds every entitlement needed for this (`SBSLaunchApplicationWithIdentifier`, backlight control), so a tweak injected into SpringBoard can just `dlopen`/`dlsym` and call them itself — no separate binary, no `sudo`, no device root password required for any of this at runtime. Root is only needed once, to `dpkg -i` the tweak.

## Known gotcha: never do SpringBoard subsystem work in `%ctor`

The SpringBoard-side `%ctor` only arms the request-file watcher — nothing else. Early versions called `preventIdleSleep`/backlight code synchronously in `%ctor` to re-apply dark mode on load, and it hung during SpringBoard's early boot (those subsystems aren't up yet), which hung SpringBoard's launch, which got killed and relaunched by the watchdog — a boot loop that tripped ElleKit's crash-guard into **safe mode** (all tweak injection disabled). The fix: the on-load dark-mode reapply is `dispatch_after`'d 15 seconds onto the bridge queue, well past boot.

If a boot loop happens again: **don't reboot** (a rootless jailbreak doesn't survive a reboot without a fresh jailbreak run). Instead, remove whatever's causing the loop (e.g. `rm /var/mobile/Library/Preferences/dev.adrian.autoinstall-dark.flag`) and run `sudo /var/jb/usr/bin/sbreload`, which cleanly reloads SpringBoard and clears safe mode without touching the kernel.
