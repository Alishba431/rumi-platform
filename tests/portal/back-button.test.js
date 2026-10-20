/**
 * Android hardware back key — what one press should do.
 *
 * Without handling, the key falls through to Android's default, which leaves
 * the app from ANY page: a teacher three screens deep in Coaching presses back
 * and is dropped out to the home screen.
 *
 * The rule, in order:
 *   1. An open dialog, sheet or menu closes first (as Escape would).
 *   2. On a home page — the dashboard or the signed-out login — back leaves
 *      the app, even if there is history behind it. Going "back" from the
 *      dashboard to the login form they just submitted is not what back means.
 *   3. Anywhere else, back goes to the previous page.
 *   4. With nothing behind (they arrived from a tapped link), back leaves the
 *      app — which returns them to wherever they tapped it.
 */

const fs = require('fs');
const path = require('path');

const { HOME_PATHS, OVERLAY_SELECTOR, resolveBackAction } = require('../../portal/src/lib/back-button.cjs');

describe('resolveBackAction', () => {
  it('closes an open dialog/sheet/menu before anything else', () => {
    expect(resolveBackAction({ path: '/portal/coaching', canGoBack: true, overlayOpen: true })).toBe('close-overlay');
    expect(resolveBackAction({ path: '/portal/dashboard', canGoBack: false, overlayOpen: true })).toBe('close-overlay');
  });

  it.each(['/portal/dashboard', '/portal/login', '/'])(
    'leaves the app from the home page %s, even with history behind it',
    (home) => {
      expect(resolveBackAction({ path: home, canGoBack: true, overlayOpen: false })).toBe('leave-app');
      expect(resolveBackAction({ path: home, canGoBack: false, overlayOpen: false })).toBe('leave-app');
    }
  );

  it('treats a trailing slash on a home page as the home page', () => {
    expect(resolveBackAction({ path: '/portal/dashboard/', canGoBack: true })).toBe('leave-app');
  });

  it.each(['/portal/lesson-plans', '/portal/coaching/session/42', '/portal/reading-assessment/7'])(
    'goes back from %s when there is a previous page',
    (page) => {
      expect(resolveBackAction({ path: page, canGoBack: true, overlayOpen: false })).toBe('history-back');
    }
  );

  it('leaves the app from an inner page with nothing behind it (arrived from a link)', () => {
    expect(resolveBackAction({ path: '/portal/coaching', canGoBack: false, overlayOpen: false })).toBe('leave-app');
  });

  it('defaults safely on missing input', () => {
    expect(resolveBackAction()).toBe('leave-app');
    expect(resolveBackAction({ path: '/portal/coaching' })).toBe('leave-app');
  });

  it('lists exactly the home pages', () => {
    expect([...HOME_PATHS].sort()).toEqual(['/', '/portal/dashboard', '/portal/login']);
  });
});

describe('OVERLAY_SELECTOR', () => {
  it('matches the open Radix overlays the portal uses (dialog, alert dialog, menu, select list)', () => {
    for (const role of ['dialog', 'alertdialog', 'menu', 'listbox']) {
      expect(OVERLAY_SELECTOR).toContain(`[role="${role}"][data-state="open"]`);
    }
  });
});

describe('App.tsx wiring', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../portal/src/App.tsx'), 'utf8');

  it('mounts the back-button handler inside the router (it needs navigate)', () => {
    const open = app.indexOf('<BrowserRouter>');
    const handler = app.indexOf('<BackButtonHandler />');
    const close = app.indexOf('</BrowserRouter>');
    expect(open).toBeGreaterThan(-1);
    expect(handler).toBeGreaterThan(open);
    expect(handler).toBeLessThan(close);
  });
});

describe('native config — the handler is switched on by the web code, not the APK', () => {
  // The plugin's handler stays OFF in the APK and BackButtonHandler turns it on
  // at runtime (toggleBackButtonHandler). So back-key behaviour ships over the
  // air, and a portal rolled back to a bundle without the handler leaves the
  // back key exactly as Android's default — never stuck.
  const config = fs
    .readFileSync(path.join(__dirname, '../../portal/capacitor.config.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('keeps disableBackButtonHandler: true in capacitor.config.ts', () => {
    expect(config).toMatch(/App\s*:\s*\{[\s\S]*disableBackButtonHandler\s*:\s*true/);
  });
});
