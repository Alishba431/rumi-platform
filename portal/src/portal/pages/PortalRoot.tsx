import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import PortalLogin from './PortalLogin';

/**
 * What "/" renders for the portal audience.
 *
 * The Android app always cold-boots to "/" — the Capacitor WebView serves the
 * bundle from https://localhost with no path — so "/" is every launch's entry
 * point. Rendering PortalLogin there unconditionally would show a teacher with
 * a perfectly valid session the login form after every force-close, and they
 * would reasonably conclude the app had logged them out.
 *
 * So "/" decides from the session rather than from the URL. useAuth's
 * checkAuth() already probes the API on mount.
 *
 * Waiting for `loading` matters as much as the redirect: rendering the form
 * while the probe is in flight would flash a login screen at an authenticated
 * user on every launch — the same wrong impression, just briefer.
 *
 * Web is unaffected. This is only reachable where the portal owns "/" (a
 * `portal.` subdomain or the native app); the marketing site still renders
 * <Index /> — see App.tsx.
 */
const PortalRoot = () => {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading || !user) return;
    navigate('/portal/dashboard', { replace: true });
  }, [user, loading, navigate]);

  // Nothing until the session is known, then either the redirect above fires
  // or there is genuinely no session and the form is the right answer.
  if (loading || user) return null;

  return <PortalLogin />;
};

export default PortalRoot;
