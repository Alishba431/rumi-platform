# Portal Android app — build, test, release

The teacher portal SPA wrapped in [Capacitor](https://capacitorjs.com) as an Android app. Same React code as
the web portal; only the build and a few runtime decisions differ. Teachers sign in once and get their
dashboard, lesson plans, coaching reports and reading assessments in an app, with the back key and tapped
portal links behaving like a native app, and the session surviving a force-close.

This is **not** the chat app. Teachers talk to Rumi in the messenger — see [Your own Android app](../docs/android-app.md).

## Prerequisites

| Need | Version | Note |
|---|---|---|
| JDK | **21** | Capacitor 8's `capacitor-android` requires Java 21. JDK 17 fails with `invalid source release: 21`. |
| Android SDK | platform **36**, build-tools, platform-tools | Command-line tools are enough. `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"` |
| Node | **22+** | The Capacitor 8 CLI (`cap sync`) refuses older Node. |
| Node deps | `npm ci` in `portal/` | |

```bash
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

## Configure — one file

Every value that makes the app *yours* lives in `portal/.env.app` (gitignored). Start from the example:

```bash
cd portal
cp .env.app.example .env.app
```

| Key | What | Default |
|---|---|---|
| `VITE_API_BASE_URL` | Absolute **https** url of your portal API, e.g. `https://portal.yourschool.example/api/portal` | none — **required** |
| `PORTAL_APP_ID` | Android package id. **Choose it once**: a store identifies the app by it forever | `org.example.rumi.portal` (placeholder; release builds refuse it) |
| `PORTAL_APP_NAME` | Launcher label (debug builds append " Debug") | `Rumi Portal` |
| `PORTAL_APP_OTA` | `1` = load the portal from your live server on launch ([OTA](#ota-updates)) | `0` |
| `PORTAL_APP_VERSION_CODE` | Integer, must go up on every release you publish | `1` |
| `PORTAL_APP_VERSION_NAME` | Shown to people | the version code |

The same keys set as **environment variables win over the file** — that is how CI passes them. They are read
by `vite build --mode app` (through the script below), by `capacitor.config.ts` (`src/lib/app-config.cjs`) and
by `android/app/build.gradle`, so the package id, label and link host can never disagree between the three.

## Build

```bash
cd portal
npm run android:debug
# -> android/app/build/outputs/apk/debug/portal-app-v1-debug.apk
```

`android:debug` chains the three steps that must never be run out of order: `build:app` (web assets **with**
the absolute API url) → `cap sync android` → `assembleDebug`. Use the script rather than the individual
commands: forgetting the app-mode flag produces a web bundle that builds green and white-screens on every
launch. Two guards make the wrong build unbuildable rather than merely broken:

- `build:app` **refuses** without an absolute https `VITE_API_BASE_URL` (`src/lib/app-build-guard.cjs`).
- Gradle **refuses** to build without an https host to claim for App Links (`preBuild`), and refuses a
  **release** build while `PORTAL_APP_ID` is still the `org.example.*` placeholder (`preReleaseBuild`).

Debug builds install as `<id>.debug`, so they sit beside a release build on the same phone.

## The portal server must allow the app

Set these on the **dashboard** service (the one that serves `/api/portal`), see `.env.template`:

| Setting | Why |
|---|---|
| `PORTAL_APP_ENABLED=true` | Two things the bundled app needs. **CORS:** adds `https://localhost` (Android) and `capacitor://localhost` (iOS) to the portal API's credentialed allow-list (`dashboard/lib/portal-app-origins.js`); without them every API call is blocked before it is sent. **Session:** the app's origin is cross-site to your API, so a `SameSite=Lax` cookie is never stored and login "silently" fails on the next request. A portal login or setup whose `Origin` is the app's gets a `SameSite=None` cookie for that session only. |
| `ANDROID_APP_PACKAGE`, `ANDROID_APP_SHA256_FINGERPRINTS` | Publishes `/.well-known/assetlinks.json` so tapped portal links open the app. See [App Links](#app-links). |

The session cookie is `Secure`, so the portal must be served over **https** — which the app requires anyway.

**What is widened, and what never is.** Only sessions created by the app's own login are `SameSite=None`.
The cookie that carries web portal sessions and admin (`/observability`) sessions stays `SameSite=Lax`
whatever you set: the dashboard has no CSRF token and accepts form posts, so a `None` admin cookie would ride
along on a form any website submits (CORS does not stop a form post). If an app session is ever used outside
`/api/portal`, it is put back to `Lax`. With [OTA](#ota-updates) on, the app loads pages from your portal
host, its requests are same-site, and its sessions stay `Lax`.

## Install and test

```bash
adb devices
adb install -r android/app/build/outputs/apk/debug/portal-app-v1-debug.apk
adb logcat | grep -iE "capacitor|chromium"     # watch for WebView errors
```

| # | Check | Expected |
|---|---|---|
| 1 | App opens | The **portal login screen** — not the public marketing page |
| 2 | Login | Succeeds with a phone number + password set up beforehand (the bot's portal setup link) |
| 3 | Data loads | Dashboard, lesson plans, coaching, reading assessments show real data |
| 4 | Session persists | Log in, swipe the app away (or `adb shell am force-stop <id>`), reopen → the dashboard, still signed in (`MainActivity.onPause()` flushes the cookie store) |
| 5 | Back key | Closes an open dialog; otherwise goes back a page; leaves the app from the dashboard or login, or when there is nothing behind |
| 6 | App Links | A tapped `https://<portal-host>/portal/dashboard` (or `/portal/login`) link opens the app, not the browser |

If login fails with the right password, look in `adb logcat` for a **CORS** error or a missing cookie before
anything else — it is almost always the server settings above.

## Web build is unaffected

`npm run build` (no app mode) still produces the website bundle with the relative `/api/portal` path and
hostname-based portal detection. One codebase, two targets — `tests/portal/app-target.test.js`.

## Release

1. **Pick your package id** (`PORTAL_APP_ID=org.yourschool.portal`) and a label. You cannot change the id
   later without shipping a second, unrelated app.
2. **Generate a signing key once** and keep it safe ([custody](#keystore-custody)):
   `keytool -genkeypair -v -keystore portal-release.jks -alias portal -keyalg RSA -keysize 4096 -validity 10000`
3. **Point the build at it** — environment variables or a gitignored `android/keystore.properties`
   (template: `android/keystore.properties.template`): `PORTAL_KEYSTORE_PATH`, `PORTAL_KEYSTORE_PASSWORD`,
   `PORTAL_KEY_ALIAS`, `PORTAL_KEY_PASSWORD`.
4. **Bump** `PORTAL_APP_VERSION_CODE` (a phone only installs an update with a higher code).
5. Build:

   ```bash
   npm run android:release
   # -> android/app/build/outputs/apk/release/portal-app-v<code>-release.apk   (side-load / GitHub Release)
   # -> android/app/build/outputs/bundle/release/portal-app-v<code>-release.aab (Google Play)
   apksigner verify --print-certs android/app/build/outputs/apk/release/portal-app-v*-release.apk
   ```

**Publish the APK** on a GitHub Release (or any https link): `gh release create portal-app-v<code>
android/app/build/outputs/apk/release/*.apk`, with the certificate SHA-256 in the notes. Teachers install it
by opening the file and allowing "Install unknown apps".

**Google Play (optional):** upload the `.aab`. Enrol in **Play App Signing** before the first upload; Play
then re-signs the app, so add the Play app-signing certificate's SHA-256 to `ANDROID_APP_SHA256_FINGERPRINTS`
(Play Console → App integrity), not only yours.

CI (`.github/workflows/portal-android-debug.yml`) builds a **debug** APK on every PR that touches `portal/**`
and uploads it as an artifact. It uses no secrets, on purpose: release signing happens where the key is.

### Keystore custody

Whoever holds the key is the only one who can update installed apps. Keep it out of the repository, back it up
in two places that are not the build machine, store the passwords separately, and write down who holds it. If
you publish through Play with Play App Signing, the key you hold is an upload key that Google can reset; if you
side-load, there is no reset — lose it and every teacher must uninstall and install a new app.

## OTA updates

The app's only native plugin (`@capacitor/app`) is feature-detected by the web code, so the web bundle *is*
the product. With `PORTAL_APP_OTA=1` the WebView loads the SPA from your live portal (`/portal/login`)
instead of the copy inside the APK: **a portal web deploy updates every installed app on its next launch.**

| Change | How it ships | Reaches users in |
|---|---|---|
| Anything in `portal/src` — UI, copy, bug fixes | Deploy the portal | Next app launch |
| Capacitor upgrade, plugins, `MainActivity`, manifest (incl. which links open the app), SDK, icon, the OTA url itself | New app release | Whenever teachers update |

How it is wired: `resolveOtaUrl()` in `src/lib/app-target.cjs` derives the origin from `VITE_API_BASE_URL`,
so the host serving the code cannot drift from the host serving the data. If it cannot be derived (unset,
relative, http), `server.url` stays unset and the bundled assets run — a known-good floor, not a blank shell.
If the portal is **unreachable at launch**, Capacitor does *not* fall back to the bundled app by itself:
without help Android shows its raw "Webpage not available" page. So the OTA config also sets
`server.errorPath` to `public/ota-fallback.html` (bundled in the APK): a "Can't reach the portal" screen
whose **Try again** reloads the portal. The portal is server-driven, so there is nothing useful to show
offline beyond that.

Under OTA the WebView runs the **web** bundle (served by the portal, so no `VITE_API_BASE_URL`), while
Capacitor still injects its global. That is why the rule in `resolveApiBaseUrl()` is "**no usable origin** ⇒
absolute url", not "native ⇒ absolute url": a page *served by* a real https host uses the relative
`/api/portal`. Do not re-tighten it; it would white-screen every OTA app.

What OTA makes load-bearing:

1. **The bundled build still has to be correct** — it runs whenever OTA is off.
2. **A bad portal deploy reaches app users too.** Roll back the portal to roll back the app.
3. **Web code must not assume a native plugin exists.** The newest bundle also runs on older APKs. Check
   `isNativePluginAvailable()` (`src/lib/runtime.ts`) and do nothing without it, as `AppLinkListener` does.

## App Links

A portal link tapped in a chat app, SMS or the browser opens the app instead of the browser, once Android has
verified the domain. Unverified, or without the app, the link opens in the browser as before.

**Claimed:** exactly `/portal/dashboard` and `/portal/login` on the build's portal host (the host of
`VITE_API_BASE_URL`). Widening the list is a manifest change, i.e. an app release; the web side
(`src/lib/app-links.cjs`) already accepts any `/portal/` page on your own origin and ignores everything else.

Configure the portal service: `ANDROID_APP_PACKAGE` = your `PORTAL_APP_ID` (or the `.debug` id for a debug
build), `ANDROID_APP_SHA256_FINGERPRINTS` = your signing certificate's SHA-256 (comma-separated if several;
the `SHA256:` line keytool prints is accepted as-is). Unset or malformed, the endpoint answers a JSON 404 and
links keep opening in the browser.

```bash
curl -si https://<portal-host>/.well-known/assetlinks.json      # 200, application/json
adb shell pm verify-app-links --re-verify <your.app.id>          # Android 12+
adb shell pm get-app-links <your.app.id>                         # want: <portal-host>: verified
```

Debug builds are signed with a per-machine debug key, so they usually cannot auto-verify. Turn the link on by
hand: `adb shell pm set-app-links-user-selection --user cur --package <id>.debug true <portal-host>`.

## Back key

The hardware back key follows `src/lib/back-button.cjs`, in order:

1. an open dialog, sheet or menu closes (as Escape would);
2. on a home page — `/portal/dashboard`, `/portal/login`, `/` — back **leaves the app**, even with history;
3. anywhere else, back goes to the **previous page**;
4. with nothing behind (the teacher arrived from a tapped link), back leaves the app, returning them to
   wherever they tapped it.

"Leave" is `App.minimizeApp()`: the session and the page survive. The plugin's handler is **off** in the APK
(`plugins.App.disableBackButtonHandler: true`) and `BackButtonHandler` switches it on at runtime, so the rule
ships over the air, and a portal bundle without the component leaves the back key at Android's default —
never stuck. Do not set the config to `false`.

## White-label checklist (portal app)

| # | What | Where |
|---|---|---|
| 1 | Package id, label, API host, OTA | `portal/.env.app` (`PORTAL_APP_ID`, `PORTAL_APP_NAME`, `VITE_API_BASE_URL`, `PORTAL_APP_OTA`) |
| 2 | Version | `PORTAL_APP_VERSION_CODE` / `PORTAL_APP_VERSION_NAME` |
| 3 | Launcher icon | `android/app/src/main/res/mipmap-*/ic_launcher{,_round,_foreground}.png` (48/108 dp at 5 densities) |
| 4 | Brand colour (icon background, launch screen) | `android/app/src/main/res/values/ic_launcher_background.xml` |
| 5 | Launch-screen mark | `android/app/src/main/res/drawable-xxhdpi/splash_mark.png` |
| 6 | Signing | `PORTAL_KEYSTORE_*` (environment or `android/keystore.properties`) |
| 7 | Portal server | `PORTAL_APP_ENABLED=true`, `ANDROID_APP_PACKAGE`, `ANDROID_APP_SHA256_FINGERPRINTS` |
| 8 | Bot links to the portal | `PORTAL_URL` in the bot's `.env` (`bot/shared/config/branding.js`) — with App Links verified, those links open the app |

You do not move any Java source to change the package id: `MainActivity` lives in the fixed namespace
`org.example.rumi.portal`, which is independent of the installed `applicationId`.

## Testing against a portal on your laptop

The app only talks https, so a portal on `localhost:4000` needs a TLS front with a certificate the phone
trusts. One way, for an emulator (`10.0.2.2` is the host machine as seen from the emulator):

1. Put an https reverse proxy in front of the dashboard (for example Caddy with an internal CA, or a
   self-signed certificate for `10.0.2.2`).
2. Build a debug APK with `VITE_API_BASE_URL=https://10.0.2.2:<port>/api/portal`.
3. Make the debug build trust your local CA: add a `src/debug/res/xml/network_security_config.xml` with a
   `<debug-overrides>` trust anchor for it (debug only — never ship this in a release).
