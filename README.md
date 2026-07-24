# autoinstall

A [Theos](https://theos.dev) tweak that lets [dkrypt](https://github.com/unbound-app/dkrypt) browse, install, and decrypt both **TestFlight** and **regular App Store** apps on a jailbroken iOS device with **zero human interaction**, including with the display off. The App Store side lets dkrypt stop depending on `ipadecrypt`'s own Apple ID login (unreliable — Apple-side rate limiting) by driving the same on-device, already-authenticated purchase pipeline the real App Store app uses, and — the hard part — **auto-confirming the install sheet headlessly** so no one ever has to tap "Install".

It injects into several processes from a single package. The functional ones:

- **`com.apple.TestFlight`** — hooks TestFlight's own private classes to list beta trains/builds via its internal REST API, and to drive a real install through its own installer, all over a file-based SSH bridge.
- **`com.apple.springboard`** — launches TestFlight or the App Store on demand via the private `SBSLaunchApplicationWithIdentifier` SPI (bypassing the fact that a display-off device otherwise refuses foreground launches through normal channels like `uiopen`), and exposes an SSH-toggleable "dark mode" that keeps the panel electrically on but at zero brightness — enough for SpringBoard to permit launches, without ever lighting up the screen.
- **`com.apple.AppStore`** — drives a real purchase/install through StoreKitUI's private `SKUIItemStateCenter` pipeline (the same one [MuffinStore](https://github.com/mineek/MuffinStore) uses), by App Store numeric id (`adamId`), with optional pinning to a specific historical version.
- **`com.apple.PassbookUIService`** — where the App Store install confirmation sheet is actually rendered (a PassKit `PKPaymentAuthorizationRemoteAlertViewController` hosting a SwiftUI authorization view). This is what makes headless installs possible: the tweak confirms the "Install" button here in-process, no synthetic touch needed. See [Headless auto-confirm](#headless-auto-confirm-the-hard-part).

A few daemons are also injected purely as introspection/injection targets (`appstored`, `amsengagementd`, `storekitd`, `coreauthd`) — each gets a minimal probe bridge, used while reverse-engineering the flow. They're harmless to leave in.

## Requirements

- A rootless jailbreak with ElleKit (tested on palera1n, iOS 18.3.2).
- [Theos](https://theos.dev) to build.
- The device signed in to an Apple ID in the App Store app (installs go through that account).
- No passcode on the device. The dark-launch mechanism relies on SBS's launch-permission check keying off backlight/display power state, not lock-screen security — it hasn't been evaluated against a passcode-locked device.

## Building

```
gmake clean package
```

Produces `packages/dev.adrian.autoinstall_<version>_iphoneos-arm64.deb`. Install with `dpkg -i` and respring (`sbreload`, not a full reboot — see below).

## The bridge protocol

Every injected side polls a request file every 200ms, writes a response file, and deletes the request file once handled. All requests are `{"action": "...", ...}` JSON; responses always include `"ok": true|false`.

### SpringBoard side (`/tmp/autoinstall-sb-request.json` → `/tmp/autoinstall-sb-response.json`)

| Action | Purpose |
| --- | --- |
| `dark_on` | Persist dark mode (survives respring) + apply it immediately (`preventIdleSleep` + `DisplayBrightnessFactor=0`). |
| `dark_off` | Clear the persisted flag and restore normal brightness/idle-sleep behavior. |
| `launch_app` (`bundleId`) | Re-applies dark mode if enabled, then SBS-launches the given bundle ID. The entry point dkrypt uses to bring TestFlight or the App Store up. |
| `screen_status` / `status` | Reports `darkEnabled`, `screenIsOn`, `screenIsDim`, `backlightState`. |

### TestFlight side (`/tmp/autoinstall-request.json` → `/tmp/autoinstall-response.json`)

| Action | Purpose |
| --- | --- |
| `list_trains` (`appId`) | Lists beta trains (version groups) for an app. |
| `list_builds` (`appId`, `trainVersion`) | Lists builds within a train. |
| `install` (`appId`, `build`) | Reconstructs the build via TestFlight's own model classes and drives a real install through the live `TFAppInstaller`. Only signals the request was *accepted* — poll the installed bundle's `Info.plist` for actual completion. |
| `status` | Reports whether the installer/catalog manager are live, and current background-execution time remaining. |
| `end_background_keepalive` | Releases the background-task assertion taken out during `install`. |
| `probe` (`class`) / `probe_live` (`target`) | Runtime-introspection helpers (dump a class's method list, or describe a stashed object). Read-only, safe to leave in. |

### App Store side (`/tmp/autoinstall-as-request.json` → `/tmp/autoinstall-as-response.json`)

| Action | Purpose |
| --- | --- |
| `install` (`adamId`, optional `versionId`) | Drives a real purchase/install through `SKUIItemStateCenter`. `adamId` is the App Store numeric track id. `versionId` (an `appExtVrsId`) pins a specific historical version — the same downgrade mechanism MuffinStore uses. Only signals the request was *accepted*; poll the on-device bundle for completion. |
| `dump_scenes` / `dump_ax` | Dump the process's `UIWindowScene`s, or its full accessibility tree (labels + button traits). |
| `find_view` / `activate_view` / `activate_ax` (`match`) | Find views/AX elements by class-or-label substring, or trigger a matching control (via `accessibilityActivate` and `sendActionsForControlEvents:`). `activate_ax` is what drives the real product-page "GET"/"re-download" button when going through the App Store's own UI. |
| `probe` / `probe_classes` / `status` | Runtime-introspection helpers. Read-only. |

The injected daemons (`appstored`, `amsengagementd`, `storekitd`, `coreauthd`) each expose a minimal probe bridge at `/tmp/autoinstall-<tag>-request.json` supporting `probe`, `probe_classes`, and (where the process has a UIApplication) `dump_scenes`/`find_view`/`activate_view`/`dump_stashed`/`confirm`.

## The App Store install call chain

Running injected in the real `com.apple.AppStore` process, so StoreKitUI is already loaded — no separate app or elevated signing needed. Adapted from MuffinStore, with one important difference: `+[SKUIClientContext defaultContext]` returns `nil` here, so a context is built from the class's own fallback config instead (that empty-looking context is enough for the purchase to go through):

```objc
NSString *offerString = [NSString stringWithFormat:
    @"productType=C&price=0&salableAdamId=%@&pricingParameters=pricingParameter&clientBuyId=1&installed=0&trolled=1", adamIdStr];
// append &appExtVrsId=<versionId> to pin a historical version

id offer = [[SKUIItemOffer alloc] initWithLookupDictionary:@{@"buyParams": offerString}];
id item  = [[SKUIItem alloc] initWithLookupDictionary:@{@"_itemOffer": adamIdStr}];
[item setValue:offer forKey:@"_itemOffer"];
[item setValue:@"iosSoftware" forKey:@"_itemKindString"];
// [item setValue:@(versionId) forKey:@"_versionIdentifier"]; // when pinning a version

SKUIItemStateCenter *center = [SKUIItemStateCenter defaultCenter];
SKUIClientContext *ctx = [SKUIClientContext defaultContext];
if (!ctx) ctx = [[SKUIClientContext alloc] initWithConfigurationDictionary:[SKUIClientContext _fallbackConfigurationDictionary]];

[center _performPurchases:[center _newPurchasesWithItems:@[item]] hasBundlePurchase:0
        withClientContext:ctx completionBlock:^(id resp){ /* SSPurchaseResponse: carries the signed IPA URL */ }];
```

Must run on the main thread (`dispatch_sync(dispatch_get_main_queue(), …)`) — the StoreKitUI singletons misbehave off it.

## Headless auto-confirm (the hard part)

`_performPurchases:` returns a valid, signed download and pops the App Store's confirmation sheet — but that sheet still needs an "Install" tap. The whole point of this tweak is to not need one.

The sheet is **not** in the App Store process at all. It's rendered out-of-process by **`PassbookUIService`** as a PassKit `PKPaymentAuthorizationRemoteAlertViewController` whose content is a **SwiftUI** `AuthorizationViewHostingController` (`PaymentUIBase`/`PassKitUI`), presented via scene-hosting — which is why it never shows up in the App Store's own windows.

To confirm it headlessly, the tweak (injected into PassbookUIService):

1. Force-enables the accessibility automation server XCUITest uses — `dlopen(/usr/lib/libAccessibility.dylib)` then `_AXSApplicationAccessibilitySetEnabled(true)` + `_AXSSetAutomationEnabled(true)`. Without an active accessibility client, SwiftUI's buttons don't exist as inspectable elements.
2. Hooks the authorization view controller, walks its **accessibility tree** (not the view tree — SwiftUI buttons are virtual `UIAccessibilityElement`s), finds the node labelled `Install`, and calls `-accessibilityActivate` on it.

No synthetic touch / HID injection (that never worked — entitlements), no guessing at private confirm methods.

**Arming it:** the confirmation only fires when the flag file `/tmp/autoinstall-autoconfirm.flag` exists; its contents are the button label to match (`Install` covers free apps — first-time GET, re-download, and update). dkrypt writes the flag before an install and removes it after, so the tweak never auto-confirms a sheet a human actually initiated.

## The full headless install, end to end

1. `echo "Install" > /tmp/autoinstall-autoconfirm.flag` — arm auto-confirm.
2. SpringBoard bridge `launch_app com.apple.AppStore`, wait for it to foreground.
3. App Store bridge `install` with the `adamId` (and optional `versionId`).
4. The PassKit sheet appears in PassbookUIService; the tweak auto-confirms it ~1s later.
5. `appstored` downloads from Apple's CDN and installs the app with its FairPlay license.
6. Remove the flag.

The result lands at `/var/containers/Bundle/Application/<UUID>/<AppName>.app` with a `SC_Info/` directory (the FairPlay `.sinf`/`.supf`/… files) — exactly what `ipadecrypt … --use-installed` then decrypts. **Watch out:** the `.app` is at container **depth 2**; the depth-1 directory is a random UUID, so poll `find /var/containers/Bundle/Application -maxdepth 2 -iname "*<name>*.app"` and check for `SC_Info/`. The app payload downloads straight into installd's staging area, not `/var/mobile/Media/Downloads`.

## Why this exists instead of a standalone CLI tool

An earlier iteration (`sbslaunch`) was a separate signed root binary that called the same private APIs directly. It turned out to be unnecessary: the target processes already hold every entitlement needed (`SBSLaunchApplicationWithIdentifier`, backlight control, StoreKitUI's purchase pipeline), so a tweak injected into them can just `dlopen`/`dlsym` and call them itself — no separate binary, no `sudo`, no device root password required at runtime. Root is only needed once, to `dpkg -i` the tweak.

## Known gotcha: never do SpringBoard subsystem work in `%ctor`

The SpringBoard-side `%ctor` only arms the request-file watcher — nothing else. Early versions called `preventIdleSleep`/backlight code synchronously in `%ctor` to re-apply dark mode on load, and it hung during SpringBoard's early boot (those subsystems aren't up yet), which hung SpringBoard's launch, which got killed and relaunched by the watchdog — a boot loop that tripped ElleKit's crash-guard into **safe mode** (all tweak injection disabled). The fix: the on-load dark-mode reapply is `dispatch_after`'d 15 seconds onto the bridge queue, well past boot.

If a boot loop happens again: **don't reboot** (a rootless jailbreak doesn't survive a reboot without a fresh jailbreak run). Instead, remove whatever's causing the loop (e.g. `rm /var/mobile/Library/Preferences/dev.adrian.autoinstall-dark.flag`) and run `sudo /var/jb/usr/bin/sbreload`, which cleanly reloads SpringBoard and clears safe mode without touching the kernel.
