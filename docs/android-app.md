# 📱 Your own Android app

> Give teachers Rumi on an app you own, brand and host — no per-message fee to anyone.

On WhatsApp, every message a business sends is a line on someone's bill, and those prices keep rising. This
guide shows how to put Rumi in teachers' pockets on your own terms instead: your app, your name and icon, your
server, signed with your key.

There are **two different apps** here. They are not two versions of one thing. Pick the one you need (or both):

| | **Rumi Messenger** (the headline) | **Portal app** (optional) |
|---|---|---|
| What the teacher opens | A chat app, like WhatsApp: colleagues, groups, calls — and **Rumi is one of the contacts** | The teacher portal (dashboard, lesson plans, coaching reports, reading assessments) in an app shell |
| Talks to Rumi? | Yes — this *is* the channel. Teachers message Rumi exactly as on WhatsApp | No — it shows what Rumi already produced |
| Needs | A Matrix chat server with Rumi on it ([Rumi Messenger](channels/matrix.md)) | Your deployed portal (the `dashboard/` service) |
| Source | Its own repo: [`Orenda-Project/element-x-android`](https://github.com/Orenda-Project/element-x-android), branch `rumi-brand` | This repo, [`portal/android/`](../portal/ANDROID.md) |
| Licence | **AGPL-3.0** (a fork of Element X) — see [your obligations](#agpl-30-what-you-must-do) | Apache-2.0, like the rest of this repo |
| Feature page | this page | [Portal app](features/android-portal-app.md) |

The rest of this page is the messenger. The portal app has its own step-by-step guide in
[`portal/ANDROID.md`](../portal/ANDROID.md).

---

## In programme terms

**Your programme's own app: branded, school-hosted, with Rumi as a contact.**

Many programmes reach teachers on low-cost Android phones, and the cost-effective uses of devices in the evidence put them in the hands of the support system. Tusome's coaches had tablets, for example [Piper-ICT16; Piper-JEC18]. This guide and its tooling let a school system publish its own Android apps, under its own name. The first is a branded messenger that signs in to the system's own server. It gives teachers colleagues, groups and calls, end-to-end encrypted, with Rumi as one of the contacts. The second is optional: the teacher portal (dashboard, lesson plans, coaching, reading results) wrapped as an app. Whenever the portal is updated, the app updates too, with no reinstall. Teachers stay signed in after closing the app. If the portal cannot be reached, they see a clear "try again" page instead of an error. The guide explains the open-source licence duties in plain words.

**Where it sits in a structured-pedagogy programme:** **delivery infrastructure** for the whole chain. The portal app also shows teachers their own lesson plans and coaching history.

### Honest limits

- **Needs the messenger channel.** The chat app needs a server running Rumi Messenger ([docs/channels/matrix.md](channels/matrix.md), v2.7.0).
- **Not yet proven.** Calls and notifications when the app is closed have not been shown to work.
- **Platform.** Android only; there is no iOS version.
- **Cost.** No cost per message or server cost was measured.
- **Licence duties.** A branded build's source code must stay public under the open-source licence.

### Sources

- [Piper-ICT16] Piper, B., Zuilkowski, S. S., Kwayumba, D., & Strigel, C., 2016, "Does technology improve reading outcomes?…", *International Journal of Educational Development* 49:204–214. https://doi.org/10.1016/j.ijedudev.2016.03.006
- [Piper-JEC18] Piper, B., DeStefano, J., Kinyanjui, E. M., & Ong'ele, S., 2018, "Scaling up successfully: Lessons from Kenya's Tusome national literacy program", *Journal of Educational Change* 19(3):293–321. https://doi.org/10.1007/s10833-018-9325-4

## Rumi Messenger for Android

A branded fork of [Element X Android](https://github.com/element-hq/element-x-android), the Matrix client.
A teacher installs an app called **Rumi**, signs in with the account their school admin created (there is no
self sign-up), and finds Rumi already in their chats. They type, send a photo of a lesson plan, or hold the
mic and send a voice note; Rumi answers in the same chat. Where WhatsApp would show buttons, Matrix has
none, so Rumi sends a numbered menu and the teacher replies `1`, `2`, … Chats, calls, photos and voice notes
are end-to-end encrypted by Element's own cryptography, which the fork does not touch.

The fork is small on purpose: about 70 files on top of upstream, each on one of Element's own extension
points, so upstream updates stay cheap to merge.

### 1. Before you start: a server, with Rumi on it

The app is only a client. It signs in to **your** Matrix homeserver, and Rumi must be a user on that same
server — otherwise teachers sign in to a server where Rumi is not there. Set both up first:

1. Run a homeserver: [`Orenda-Project/rumi-messenger`](https://github.com/Orenda-Project/rumi-messenger)
   (Synapse + Element Web + calls + push, with scripts to create teacher accounts).
2. Connect this repo's bot to it: **[Run Rumi on your own messenger](channels/matrix.md)** (set
   `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN`; Matrix runs next to WhatsApp, or instead of it with
   `CHANNEL_DRIVER=none`).
3. Check it from a browser first: sign in to your Element Web as a test teacher and message Rumi. If that
   works, the app will.

### 2. Try it before you brand it

- **Download** a signed build from the fork's
  [releases](https://github.com/Orenda-Project/element-x-android/releases/latest): `arm64-v8a` for almost
  every phone, `universal` if unsure, `x86_64` for an emulator. Each release carries `SHA256SUMS`.
- **Install:** open the APK on the phone and allow "Install unknown apps" for your browser or file manager
  when Android asks.
- **Sign in:** on the first screen choose to change the server and type your server's address
  (`https://chat.yourschool.example`, or `http://<lan-ip>:8008` on a school LAN), then the teacher's
  username and password.

### 3. The white-label checklist — every value you change

Fork `Orenda-Project/element-x-android`, work on a branch from `rumi-brand`, and change:

| # | What | Where (in the fork) | Notes |
|---|---|---|---|
| 1 | **Package id** and **app name** | `plugins/src/main/kotlin/config/BuildTimeConfig.kt` — `APPLICATION_ID`, `APPLICATION_NAME` | Default `ai.hellorumi.messenger` / `Rumi`. Choose your id **once**: Android (and any store) identifies the app by it forever, and a phone only upgrades an app signed with the same key under the same id |
| 2 | **Default server** shown on first launch | `features/enterprise/impl-foss/src/main/kotlin/io/element/android/features/enterprise/impl/DefaultEnterpriseService.kt` — `accountProviderAllowList()` | Default `rumi.example`, a deliberately non-resolving placeholder. Put your homeserver's name here so teachers never type a server address. Teachers can still pick another server |
| 3 | **Brand colours** | `features/enterprise/impl-foss/src/main/kotlin/io/element/android/features/enterprise/impl/rumi/RumiSemanticColors.kt` | Overrides only the primary-action and accent tokens; surfaces and text stay upstream's |
| 4 | **Onboarding hero** (first screen) | `app/src/main/res/drawable-{,night-}{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/onboarding_logo.png` | 10 PNGs: 5 densities × light/night. When the drawable exists Element draws it in place of its own logo and headline — no code |
| 5 | **Launcher icon** | `appicon/element/src/main/res/mipmap-*` (`ic_launcher`, `_round`, `_foreground`, `_monochrome` `.webp`) and `appicon/element/src/{debug,nightly,release}/res/drawable/ic_launcher_background.xml` | Keep the adaptive-icon safe zone |
| 6 | **Copy** | `app/src/main/res/values{,-en-rUS,-<lang>}/rumi_strings.xml`, `libraries/push/impl/src/main/res/values{,-<lang>}/rumi_strings.xml` | Login subtitle, notification sound label, the plain-language "new phone" screens. The fork ships English plus one second language; add a `values-<lang>` folder for yours |
| 7 | **Signing key** | GitHub secrets `RUMI_KEYSTORE_B64`, `RUMI_KEYSTORE_PASSWORD`, `RUMI_KEY_ALIAS`, `RUMI_KEY_PASSWORD` | See [keystore custody](#keystore-custody). Publish your certificate's SHA-256 so people can check a download |
| 8 | **Release workflow guard** | `.github/workflows/rumi-release.yml` — `if: github.repository == 'Orenda-Project/element-x-android'` | Change to your fork's `owner/repo`, or the job never runs |
| 9 | **README and links** | `README.md`, `.rumi/README.md` | Your download link, teacher guide and issue tracker |

Things you do **not** need to change (the fork already does them for schools): no "Create account" button
(`appconfig/.../OnBoardingConfig.kt`, `CAN_CREATE_ACCOUNT = false`), no analytics or consent screen, no Labs,
instant sign-in against plain-http school servers, and messages are never blocked by a teacher's own old phone
after a reinstall.

### 4. Build it

You need **JDK 21** and the Android SDK (command-line tools are enough; Android Studio is optional).

```bash
git clone --branch rumi-brand https://github.com/<you>/element-x-android.git
cd element-x-android

# Debug build — installs beside nothing, signed with the public debug key. For trying changes.
./gradlew assembleFdroidDebug
ls app/build/outputs/apk/fdroid/debug/        # app-fdroid-{arm64-v8a,x86_64,universal,...}-debug.apk
adb install -r app/build/outputs/apk/fdroid/debug/app-fdroid-x86_64-debug.apk   # emulator
```

A **signed release** build reads its key from the environment (the same names the release workflow uses):

```bash
export RUMI_KEYSTORE_FILE=/secure/path/messenger-release.jks
export RUMI_KEY_ALIAS=messenger
export RUMI_KEYSTORE_PASSWORD=...  RUMI_KEY_PASSWORD=...
export RUMI_BUILD_NUMBER=1                 # versionCode = 30,000,000 + this (CI uses the run number)
export RUMI_VERSION_SUFFIX=1.0.0-yourschool # appended to Element's version name
./gradlew assembleFdroidRelease
apksigner verify --print-certs app/build/outputs/apk/fdroid/release/app-fdroid-arm64-v8a-release.apk
```

Measured on a laptop for this release: a debug build took about 4 minutes with a warm Gradle cache (expect
15+ minutes cold), and the signed release about 17 minutes. Both produce per-ABI APKs plus a `universal` one.

### 5. Publish an APK (GitHub Releases)

The fork's `.github/workflows/rumi-release.yml` does this on every `v*` tag: builds the F-Droid flavour,
signs it with your secrets, verifies the signature, and publishes `arm64-v8a`, `x86_64` and `universal` APKs
with `SHA256SUMS` and the certificate fingerprint in the release notes.

1. Add the four `RUMI_*` secrets to your fork (Settings → Secrets and variables → Actions). For
   `RUMI_KEYSTORE_B64`: `base64 -i messenger-release.jks | pbcopy` (macOS) or `base64 -w0 messenger-release.jks`.
2. Fix the repository guard (checklist row 8).
3. `git tag v1.0.0-yourschool && git push origin v1.0.0-yourschool`.
4. Share the release page link with teachers. Updates are installed the same way, over the old app — they
   keep their chats as long as the package id and signing key are unchanged.

### 6. Optional: Google Play

The F-Droid flavour is what the release workflow ships: it pushes notifications through **UnifiedPush**
(a self-hosted [ntfy](https://ntfy.sh) on your server), with no Google services. Play distribution is possible
but is not something this release has exercised. What it involves:

- Build the `gplay` flavour as an app bundle: `./gradlew bundleGplayRelease`. That flavour pushes through
  Firebase; upstream's Firebase settings live in `libraries/pushproviders/firebase/` and must point at **your**
  Firebase project.
- A Play Console developer account, a store listing, the data-safety form, and review.
- **Enrol in Play App Signing before your first upload.** Play then re-signs your app with a key it holds;
  the key you upload with becomes an *upload key*, which Google can reset if you lose it.

### Keystore custody

Whoever holds the signing key is the only one who can ship an update to installed apps. Lose it and every
teacher has to uninstall and install a new app; leak it and someone else can ship an
"update". So:

- Generate it once: `keytool -genkeypair -v -keystore messenger-release.jks -alias messenger -keyalg RSA
  -keysize 4096 -validity 10000`.
- Keep it **out of the repository** and out of chat. CI gets it only as a base64 secret.
- Back it up in two places that are not the build machine (an encrypted password manager entry and an
  offline copy), with the passwords stored separately. Write down who holds it.
- Publish the certificate's SHA-256 (`apksigner verify --print-certs`) in your README. It is public, not a
  secret, and lets anyone check a download is yours.

### AGPL-3.0: what you must do

Element X is licensed AGPL-3.0, so the fork is too, and so is **your** branded build. In plain terms:

1. **Publish your source.** Anyone you give the app to (every teacher who installs it) is entitled to the
   complete corresponding source of the version they have, including your branding changes. The simplest way
   is a public fork with a tag per release, linked from the release notes.
2. **Keep the licence.** Leave the `LICENSE` file and the copyright notices; mark your changes (a commit
   history does this).
3. **No extra restrictions.** You cannot add terms that forbid teachers or anyone else from modifying and
   sharing the app further.
4. **Your server code is separate.** Running Rumi (this repo, Apache-2.0) and Synapse behind the app does not
   make them AGPL; the obligation is about the app you distribute.

This is a summary, not legal advice; read the licence text in the fork's `LICENSE`.

### Notifications and calls with the app closed

The F-Droid build receives notifications (and rings for calls) through UnifiedPush: the teacher installs the
ntfy app once, points it at your server's ntfy, and the messenger registers with it. `rumi-messenger` sets
ntfy up. A plain-http ntfy on a school LAN works; the fork keeps the `http://` gateway instead of discarding it.

### Keeping current

Element ships roughly every one to two weeks. Merge upstream `develop` into your branch on a schedule, not on
memory, rebuild, and re-test sign-in, a message to Rumi, a photo and a voice note before tagging.

### What this release proved, and on what

Built from a clean clone of the fork at `rumi-brand` `376ae66a95` (debug, and a signed release with a
throwaway key), installed on an Android 15 emulator, and signed in to a local homeserver with a test teacher
account. Proven end to end against a locally running Rumi: sign-in in about 9 seconds with no "Create account"
button; Rumi's invite and greeting; a quiz answered from a numbered menu; a photo and a voice note answered on
their content (with a spoken reply); a lesson-plan PDF delivered and opened in the app; and, after an uninstall
and reinstall on the "new phone", a message in the existing chat sent without being blocked. **Not proven:**
calls and notifications with the app closed — that needs a UnifiedPush distributor on the phone and an ntfy your
homeserver is allowed to reach.

### Troubleshooting sign-in

- **"We couldn't reach this account provider"** with a correct address: the app follows your server's
  `/.well-known/matrix/client` `base_url`. It must be an address **phones** can reach (not `127.0.0.1` or a
  name that only resolves inside your network).
- **"An error occurred, you may not receive notifications"** right after sign-in: no UnifiedPush distributor is
  installed. Chats still work while the app is open; install ntfy for notifications.
