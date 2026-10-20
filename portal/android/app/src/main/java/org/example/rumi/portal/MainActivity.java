package org.example.rumi.portal;

import android.webkit.CookieManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Keep the portal session across a force-close.
     *
     * The session cookie itself is correct — the portal sets it with a 7-day
     * Max-Age and Secure, so it is a *persistent* cookie the WebView is allowed
     * to keep. The failure is purely client-side: Android's WebView holds
     * cookies in an in-memory store and only flushes them to disk on its own
     * schedule. Swiping the app away is a hard process kill that tears the
     * process down before that flush runs, so the cookie is never written and
     * the next launch starts with an empty cookie jar — dropping the teacher
     * back on the login screen.
     *
     * Flushing on every pause persists the cookie to disk the moment the app is
     * backgrounded, so a subsequent kill can no longer lose it. flush() is cheap
     * and idempotent, and onPause always fires before the process can be killed.
     */
    @Override
    public void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
