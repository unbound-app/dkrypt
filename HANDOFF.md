# Handoff: autoinstall App Store target + dropping ipadecrypt's Apple ID auth

Written 2026-07-24 for whoever picks this up next (human or another AI agent/tool). Read this whole file before doing anything — it front-loads the gotchas that cost real time to find.

## The goal, in one paragraph

`dkrypt` (github.com/unbound-app/dkrypt, `/Users/adrian/Developer/dkrypt`) decrypts App Store IPAs on a jailbroken iPad. For TestFlight builds it never touches Apple's fragile private login API — the `autoinstall` tweak (this repo, was named `tfauto` until today) drives TestFlight's own already-authenticated on-device install pipeline instead. For regular App Store apps, `dkrypt` currently still shells out to `ipadecrypt --from-appstore`, which does its own Apple ID login against `auth.itunes.apple.com` — an endpoint that is currently unreliable (Apple-side rate limiting / intermittent 404s, a known issue shared with `ipatool`, see `londek/ipadecrypt#25` and `majd/ipatool#480`/`#482`). The plan: give App Store apps the same treatment TestFlight already gets — a third injection target in this tweak that drives the App Store's own on-device purchase pipeline (via StoreKitUI private classes, same technique as [MuffinStore](https://github.com/mineek/MuffinStore)) — then delete `ipadecrypt`'s Apple ID auth path from `dkrypt` entirely once that's proven reliable. The user has explicitly decided: rip the old auth path out once the new one works, don't keep it as a dormant fallback.

## Current state as of this handoff

1. **Done, committed, pushed to `dkrypt` main** (`802ae3d`): fixed `api/src/jobs/runner.ts` — `ipadecrypt` can print an `[err] prepare failed: ...` line and still exit 0, which was making the job runner fall through to a misleading ENOENT (from the missing output file) instead of the real error. Now any `[err]` line is treated as failure regardless of exit code. This was the original bug report this whole thread started from — it's fixed and live, unrelated to everything below.
2. **Done**: this repo renamed `tfauto` → `autoinstall` (package id, `TWEAK_NAME`, plist filename, all bridge/log/flag paths, README). Builds clean (`gmake clean package`). Two commits on branch `probe/appstore-skui`:
   - `edcbadd` — adds `com.apple.AppStore` as a third filter target with a **probe-only** bridge (`probe_skui` action, read-only, dumps whether `SKUIItemStateCenter`/`SKUIItem`/`SKUIItemOffer`/`SKUIClientContext` and their needed selectors exist on this device's iOS build — does not call any of them yet).
   - `fb28bf2` — the tfauto→autoinstall rename itself.
   - Not merged to `main` yet (this repo has no real `main` history beyond the initial commit — it's local-only, never pushed anywhere, per earlier project research).
3. **Not done yet, blocked**: the probe build (`packages/dev.adrian.autoinstall_0.2.0_iphoneos-arm64.deb`) is staged at `/tmp/autoinstall-probe.deb` on the device but **not installed**. Installing needs root (`sudo dpkg -i`), and this device's `mobile` user needs a password typed interactively for every `sudo` call — see "Device access" below for why passwordless sudo isn't set up despite real effort.
4. **Not started**: the real App Store install-driving hook (beyond the probe), the `dkrypt`-side wiring, and retiring the Apple ID auth path. See "Next steps" below.

## Immediate next step

Someone with the device password needs to run, from a terminal (not scripted through an AI agent that won't handle credentials — see below):

```bash
ssh mobile@192.168.2.158 'sudo dpkg -i /tmp/autoinstall-probe.deb && sudo sbreload'
```

Then launch the App Store app on-device (check `ps aux | grep -i appstore` first; if resident, `sudo killall AppStore` before relaunching — SBS refuses a second launch request for an app it thinks is already alive, same behavior documented for TestFlight in the research memory below) and `uiopen --bundleid com.apple.AppStore`. Once running, write `{"action":"probe_skui"}` to `/tmp/autoinstall-as-request.json` on-device, read back `/tmp/autoinstall-as-response.json` (and `/tmp/autoinstall.log` for detail). That tells us whether MuffinStore's exact API surface still matches on this iOS version before investing in the real hook.

## Device access

- iPad7,11, iOS 18.3.2, palera1n rootless jailbreak, hostname `Adrians-iPad`.
- Directly reachable on the LAN at `mobile@192.168.2.158` (DHCP, may drift) — this Mac's `~/.ssh/id_ed25519` is now an authorized key there (added by the user mid-session today), so `ssh mobile@192.168.2.158` needs no password.
- Also reachable via `homelab.local` → `iproxy` loopback tunnel at `127.0.0.1:2222` (what the `dkrypt` container itself uses) — SSH alias `ipad` in homelab's own `~/.ssh/config`, key `~/.ssh/id_ed25519_ipad` on homelab. Same device, different path.
- **No root SSH exists** — `/var/root/.ssh/authorized_keys` doesn't exist on the device at all, confirmed directly. Only `mobile` has a key.
- **`mobile` has sudo, but it prompts for a password every time.** An attempt to set up `NOPASSWD` via `/var/jb/etc/sudoers.d/mobile-nopasswd` (content: `mobile ALL=(ALL) NOPASSWD: ALL`, mode 440) did **not** take effect — `sudo -n true` still fails from a fresh session. This is a **real, unresolved mystery**, not abandoned because it's unsolvable, just deprioritized after a lot of failed attempts:
  - `#includedir /var/jb/etc/sudoers.d` was already present (`grep -c sudoers.d /var/jb/etc/sudoers` returned 3 *before* anything was added), so a missing includedir isn't the cause.
  - Nobody has actually read the drop-in file's contents back as root yet (`sudo cat /var/jb/etc/sudoers.d/mobile-nopasswd`) to confirm it saved correctly, or run `sudo visudo -c` for a real syntax check (see the dyld gotcha just below for why that crashes if you forget the env var). That's the obvious next diagnostic step, just never got done.
  - Every apparent "it worked" during this session was actually sudo's normal ~5-minute per-session credential cache firing right after someone typed the password for something else, not the `NOPASSWD` rule itself — confirmed by testing from a *separate* fresh SSH connection, which still demanded a password every time.
- **The device's root/sudo password is known to the user, not written anywhere in this repo or in dkrypt's config on purpose.** Whoever operates this device needs to type it interactively for privileged one-off commands until the sudoers issue above is actually solved. Do not ask an AI agent to type, echo, or pipe it — that's a hard boundary that held for the entire session this rename/probe work happened in, and printing it into this file would undo the point of holding it. `dkrypt`'s own container *does* store this device password (for `ipadecrypt`'s own SSH automation) at `/root/.ipadecrypt/config.json` → `.device.auth.password` inside the container on `homelab.local` — a human can retrieve it from there if needed, an AI agent should not be asked to extract and use it.

## Device gotchas (cost real time to find — don't rediscover)

- **Everything lives under `/var/jb/`, not the real `/usr`, `/etc`.** This is a rootless jailbreak. `dpkg` is at `/var/jb/usr/bin/dpkg`, `sbreload` at `/var/jb/usr/bin/sbreload`, sudoers at `/var/jb/etc/sudoers`. Don't assume standard paths — check with `which` first. (This exact mistake caused a wasted round-trip earlier today: a sudoers rule was written for `/usr/bin/dpkg`, the real binary, which didn't match.)
- **`sudo`/`visudo` (procursus package `sudo` 1.9.15p5) has a broken library search path.** `libsudo_util.0.dylib` actually lives at `/var/jb/usr/libexec/sudo/libsudo_util.0.dylib` (confirmed present on disk, and it's what `dpkg -L sudo` lists), but the compiled binaries search `/var/jb/usr/lib/`, `/cores/binpack/usr/lib/libroot/`, etc. and crash with a dyld abort (`Library not loaded: @rpath/libsudo_util.0.dylib`) before doing anything else. **Workaround, confirmed working**: prefix the invocation with `DYLD_LIBRARY_PATH=/var/jb/usr/libexec/sudo`, e.g. `DYLD_LIBRARY_PATH=/var/jb/usr/libexec/sudo /var/jb/usr/sbin/visudo -c`. This gets you past the crash to the real permission-denied-as-non-root error underneath. Whether `sudo` (not `visudo`) passes this env var through to itself when invoked as `sudo DYLD_LIBRARY_PATH=... visudo ...` is untested — sudo's `env_reset` may strip it; if so, `su`-ing or finding another way to invoke `visudo` as root with that env var set is the next thing to try.
- **Standard tools are sometimes missing or relocated.** No `otool` found on this device. `ifconfig` is at `/cores/binpack/sbin/ifconfig`, not the usual path. `netstat` runs but produces no output at all (not just filtered — genuinely non-functional on this jailbreak, don't trust an empty result as "nothing's listening").
- **`uiopen --bundleid <id>` only launches an app cleanly if no stale instance is already resident.** If SpringBoardServices thinks the app is already alive (even backgrounded/suspended), it silently refuses the launch (exit 0, no crash, nothing happens). Kill any existing process first (`sudo killall AppStore`, or `TestFlight`/`TestFlightServiceExtension` for that target) before relaunching.

## The actual App Store install call chain (from MuffinStore, adapted, not yet implemented as a real hook)

Confirmed via reading `mineek/MuffinStore`'s `MFSRootViewController.m` directly (actively maintained, pushed within the last 2 weeks as of this writing). It doesn't hook anything — running with jailbreak/TrollStore entitlements and StoreKitUI already loaded, it just calls the private purchase pipeline directly, which uses whatever Apple ID session is already authenticated on-device:

```objc
SKUIItemOffer *offer = [[SKUIItemOffer alloc] initWithLookupDictionary:@{@"buyParams": offerString}];
SKUIItem *item = [[SKUIItem alloc] initWithLookupDictionary:@{@"_itemOffer": adamId}];
[item setValue:offer forKey:@"_itemOffer"];
[item setValue:@"iosSoftware" forKey:@"_itemKindString"];
// [item setValue:@(versionId) forKey:@"_versionIdentifier"]; // optional: pins a historical version
SKUIItemStateCenter *center = [SKUIItemStateCenter defaultCenter];
[center _performPurchases:[center _newPurchasesWithItems:@[item]] hasBundlePurchase:0
        withClientContext:[SKUIClientContext defaultContext] completionBlock:^(id arg1){ ... }];
```

Where `offerString` (a `buyParams`-style query string) is built as:
```
productType=C&price=0&salableAdamId=<adamId>&pricingParameters=pricingParameter&appExtVrsId=<versionId>&clientBuyId=1&installed=0&trolled=1
```
(the `appExtVrsId` segment is dropped entirely when not pinning a specific version — see MuffinStore's `downloadAppWithAppId:versionId:` for the exact conditional).

`SKUIItemStateCenter defaultCenter` is a plain class-method singleton — **no hooking/stashing required** to get a live instance, unlike TestFlight's `TFAppInstaller`/`TFAppCatalogManager` (which needed `%hook` on their init methods to stash a live instance into a global, since they're constructed by some other SpringBoard/TestFlight-internal object). This should make the App Store hook simpler than the TestFlight one was.

**This has not been tested against a live purchase yet.** The probe (`probe_skui` action, already built, see "Immediate next step") only confirms the classes and selectors still exist — it doesn't call them. Once that's confirmed, wrap the real call in `@try`/`@catch` per the lessons below before actually triggering a purchase.

## Hard-won lessons from the TestFlight side (apply directly to the App Store hook too)

Full detail in a much longer prior research memory: `/Users/adrian/.claude/projects/-Users-adrian-ipadecrypt-service/memory/project_tfauto_testflight_research.md` (1200+ lines — read it before redoing any of this investigative work, it has the complete class map, endpoint list, and every dead end already hit). Highlights that generalize:

- **A `dispatch_source_t` timer created as a local variable inside `%ctor` gets deallocated immediately and never fires.** Must be a `static` global.
- **Never invoke an undocumented completion block with a guessed multi-argument signature.** Declare it `void (^)(void)` (zero params) — under-declaring is safe on arm64 (extra args the caller passes just go unread), guessing a wrong typed signature crashes via an uncaught `NSInvalidArgumentException` when you message a not-actually-that-type object.
- **Never pass `nil` for a completion block parameter to an undocumented API without confirming it's optional** — invoking a nil block as a raw function pointer is `EXC_BAD_ACCESS`, unlike messaging `nil` which is always safe in Objective-C.
- **Wrap any unverified private-API call chain in `@try`/`@catch`, log the exception, write it to the response file.** Turns a device-crashing bug into a one-line diagnostic on the next attempt. Do this by default for new hook code, not reactively after a crash.
- **`frida` does not work on this device** (both attach and spawn modes fail — attach hangs indefinitely, spawn crashes inside `dyld4::APIs::dlopen_from`, likely a frida-vs-iOS-18.3-dyld compatibility bug, not a device/entitlement issue). Use the tweak's own `probe`/`probe_live` bridge actions (already built, dump `class_copyMethodList` for a class name or a live-stashed object) for runtime introspection instead — this is what actually worked for the TestFlight side.

## Next steps, in order

1. Get the probe deb installed (blocked on a human running the one-liner in "Immediate next step" — do not have an AI agent type the device password to unblock this).
2. Run `probe_skui`, confirm `SKUIItemStateCenter`/`SKUIItem`/`SKUIItemOffer`/`SKUIClientContext` and their selectors exist. If a selector is missing, `probe`/`probe_live`-style introspection (see lessons above) on the actual live classes will find whatever replaced it.
3. Implement the real `install` action on the App Store bridge target, adapted from the call chain above, `@try`/`@catch`-wrapped. Test against a real (probably free/small) app first.
4. Confirm the installed app's `Info.plist` reflects the requested version, then confirm `ipadecrypt decrypt <bundleId> --use-installed` works against it unchanged — same validation pattern already proven for TestFlight (see the research memory's "FULL LOOP VALIDATED" section).
5. Wire `dkrypt`: a new `api/src/appStoreInstall.ts` mirroring `api/src/testflight.ts`'s shape, a generic job flag decoupled from TestFlight metadata (today `--use-installed` is gated behind `job.testflight` in `api/src/jobs/types.ts` — needs to also trigger for App-Store-sourced installs), and `api/src/jobs/runner.ts` branching updated accordingly.
6. Only after 3–5 are proven reliable end-to-end: delete `api/src/appleAuthRunner.ts`, the `/v1/dashboard/apple-auth/*` routes in `api/src/routes/dashboard.ts`, the corresponding dashboard UI, and stop calling `ipadecrypt bootstrap`/storing the Apple ID password at all. This was an explicit, deliberate decision by the user (rip it out, don't keep it as a fallback) — not something to second-guess or soften back into "keep both paths" without asking again.

## Repo/file map for orientation

- This tweak: `/Users/adrian/Developer/autoinstall` (Theos project — `Makefile`, `control`, `autoinstall.plist`, `sources/Tweak.x`). Build with `gmake clean package` (needs `$THEOS` set, already is on this Mac at `~/theos`). Local git repo, branch `probe/appstore-skui`, never pushed to a remote.
- `dkrypt` API: `/Users/adrian/Developer/dkrypt/api/src` — `jobs/runner.ts` (spawns `ipadecrypt`), `jobs/store.ts` (queue/retry/dispatch logic), `jobs/types.ts` (`Job` shape, `TestFlightJobSource`), `testflight.ts` (the existing tfauto/autoinstall bridge client, to be mirrored for App Store), `appleAuthRunner.ts` (the Apple ID bootstrap flow being retired), `idevice.ts` (low-level SSH + bridge request/response file plumbing — has the `/tmp/tfauto-*` path constants that **must be updated to `/tmp/autoinstall-*`** once this tweak actually replaces the deployed one for real TestFlight use, not just App Store probing).
