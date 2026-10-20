# 📱 Portal app — the teacher portal as an Android app

> The teacher's dashboard, lesson plans, coaching reports and reading assessments, in an app on their phone —
> with your name, your icon, and updates that ship with every portal deploy.

## What it is

The teacher portal is a web app. Most teachers live on their phones, and "open the browser, find the link,
sign in again" is where they drop off. The portal app wraps the same portal in an Android app shell: the
teacher signs in once, and from then on one tap opens their dashboard. It is a WebView wrap built with
Capacitor, not a rewrite — the screens are the portal's own.

It is **not** the chat app. Teachers talk to Rumi in [Rumi Messenger](../android-app.md); this app shows them
what Rumi has produced for them.

## How it works

1. **One config, three readers.** `portal/.env.app` holds the package id, label, the portal API url and the
   OTA switch. Vite (`npm run build:app`), `capacitor.config.ts` and Gradle all read it, environment first.
2. **Know where it is running.** Inside the app the page is served from `https://localhost`, so the portal
   decides "portal or marketing site?" and "where is the API?" through `src/lib/app-target.cjs`, not by
   sniffing the hostname. A bundled app uses the absolute API url; a page served by the portal itself uses the
   relative one.
3. **Over-the-air updates.** With `PORTAL_APP_OTA=1` the app loads the portal from your server on launch, so a
   web deploy is an app update. If the server can't be derived, the copy bundled in the APK runs instead; if it can't be reached at launch, the app shows a bundled "Can't reach the portal" screen with **Try again**.
4. **Native touches.** Tapped `/portal/dashboard` and `/portal/login` links open the app (Android App Links,
   verified against `/.well-known/assetlinks.json` served by the portal); the back key closes dialogs, goes
   back a page, or leaves from a home page; the session cookie is flushed to disk when the app is
   backgrounded, so a force-close does not log the teacher out.
5. **Server side.** With `PORTAL_APP_ENABLED=true` the portal API allows the app's origin (CORS) and gives
   a login made from the app a cookie it can hold (`SameSite=None`). Web and admin sessions stay `SameSite=Lax`.

## What the teacher experiences

They tap the app's icon, see the portal's login screen (not the marketing site), sign in with their phone
number and the password they set from Rumi's setup link, and land on their dashboard. Tomorrow they tap the
icon and are on the dashboard straight away. When a colleague shares a dashboard link in chat, tapping it
opens the app on that page.

## Enable it

Nothing on the bot changes. To build your own app:

```bash
cd portal
cp .env.app.example .env.app      # set VITE_API_BASE_URL, PORTAL_APP_ID, PORTAL_APP_NAME
npm ci
npm run android:debug             # needs JDK 21 + the Android SDK
```

On the dashboard service set `PORTAL_APP_ENABLED=true`, and for App Links `ANDROID_APP_PACKAGE` and
`ANDROID_APP_SHA256_FINGERPRINTS` (all in `.env.template`). Release builds, signing, publishing an APK, Google
Play, OTA and the full white-label checklist: **[portal/ANDROID.md](../../portal/ANDROID.md)**.

| Variable | Where | What |
|---|---|---|
| `VITE_API_BASE_URL` | `portal/.env.app` | absolute https url of your portal API — required |
| `PORTAL_APP_ID` | `portal/.env.app` | Android package id (release builds refuse the `org.example.*` placeholder) |
| `PORTAL_APP_NAME` | `portal/.env.app` | launcher label |
| `PORTAL_APP_OTA` | `portal/.env.app` | `1` = load the portal from your server on launch |
| `PORTAL_KEYSTORE_PATH`, `PORTAL_KEYSTORE_PASSWORD`, `PORTAL_KEY_ALIAS`, `PORTAL_KEY_PASSWORD` | build environment | release signing |
| `PORTAL_APP_ENABLED` | dashboard `.env` | `true` so the app is allowed (CORS) and can hold a session (default off) |
| `ANDROID_APP_PACKAGE`, `ANDROID_APP_SHA256_FINGERPRINTS` | dashboard `.env` | publish `assetlinks.json` for App Links |

## Limits

- Android only. `capacitor://localhost` is already allowed for an iOS shell, but no iOS project ships.
- The portal is server-driven: without a connection the app shows its login screen and cannot load data.
- PDFs open inside the app's WebView (so the session goes with them); Android's WebView has no PDF viewer, so
  they download rather than render.
