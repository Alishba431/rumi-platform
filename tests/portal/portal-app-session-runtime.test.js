/**
 * The session and CORS wiring for the portal app, run for real.
 *
 * One cookie (`app.sid`) carries both the teacher-portal session and the admin
 * (/observability) session, and the dashboard has no CSRF token and accepts
 * form posts. If that cookie were ever SameSite=None, any website could
 * auto-submit a form to an admin endpoint with the admin's cookie attached —
 * CORS does not stop a form post. So an admin session must never be
 * SameSite=None, whatever the app settings are. Only a portal login that comes
 * from the bundled app's own origin, with PORTAL_APP_ENABLED on, gets 'none'.
 *
 * This boots express with the real express-session, the session cookie options
 * dashboard/index.js uses, the real cors middleware and the real portal router
 * (dashboard/routes/portal.routes.js). Only the database is faked.
 */

const fs = require('fs');
const http = require('http');
const { createRequire } = require('module');
const path = require('path');

const DASHBOARD = path.join(__dirname, '../../dashboard');

const mockDb = { user: null };
jest.mock('../../dashboard/config/supabase', () => {
  const query = () => {
    const q = {
      select: () => q,
      update: () => q,
      eq: () => q,
      single: async () => (mockDb.user ? { data: mockDb.user, error: null } : { data: null, error: { message: 'no rows' } }),
      then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
    };
    return q;
  };
  return { from: () => query() };
});

// The dashboard's own dependencies, resolved the way dashboard/index.js resolves
// them. CI installs them (ci.yml, portal-android-debug.yml, fresh-clone-smoke.yml)
// and must run this suite, so a missing install fails there. A local `npm test`
// without `cd dashboard && npm ci` skips it with a message instead.
const HAVE_DASHBOARD_DEPS = fs.existsSync(path.join(DASHBOARD, 'node_modules', 'express-session'));
const RUN = HAVE_DASHBOARD_DEPS || Boolean(process.env.CI);
if (!RUN) {
  console.warn('portal-app-session-runtime: skipped — run `cd dashboard && npm ci` to boot the real session stack.');
}
const dashboardRequire = createRequire(path.join(DASHBOARD, 'package.json'));
const [express, session, cors, bcrypt] = RUN
  ? ['express', 'express-session', 'cors', 'bcryptjs'].map((m) => dashboardRequire(m))
  : [];

const {
  buildPortalCorsOrigins,
  isPortalAppEnabled,
  keepSessionsLaxOutsidePortalApi,
  sessionCookieOptions,
} = require('../../dashboard/lib/portal-app-origins');

const PORTAL_URL = 'https://portal.example.org';
const APP_ORIGIN = 'https://localhost';
const PASSWORD = 'correct-horse-1';

/** The dashboard's session + portal stack, in index.js order. */
function bootDashboard() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    name: 'app.sid',
    resave: false,
    saveUninitialized: false,
    cookie: sessionCookieOptions(),
  }));
  app.use(keepSessionsLaxOutsidePortalApi);

  // What index.js's admin POST /login does once the password checks out.
  app.post('/login', (req, res) => {
    req.session.isAuthenticated = true;
    req.session.userRole = 'super_admin';
    res.json({ ok: true });
  });

  const portalRoutes = require('../../dashboard/routes/portal.routes');
  const portalCors = cors({
    origin: buildPortalCorsOrigins({ portalUrl: PORTAL_URL, appEnabled: isPortalAppEnabled(process.env) }),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: true,
  });
  app.use('/api/portal', portalCors, portalRoutes);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'POST', path: urlPath, headers = {}, body }) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: urlPath,
      headers: {
        'X-Forwarded-Proto': 'https',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const setCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('app.sid=')) || '';
const cookiePair = (res) => setCookie(res).split(';')[0];

const portalLogin = (server, origin, extraHeaders = {}) => request(server, {
  path: '/api/portal/login',
  headers: { Origin: origin, ...extraHeaders },
  body: { phoneNumber: '15551234567', password: PASSWORD },
});

(RUN ? describe : describe.skip)('portal app session wiring (real express-session + portal router)', () => {
  let server;
  const savedEnv = process.env.PORTAL_APP_ENABLED;

  beforeAll(async () => {
    mockDb.user = {
      id: 'u-1',
      first_name: 'Test',
      portal_activated: true,
      portal_password_hash: await bcrypt.hash(PASSWORD, 4),
    };
  });

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    server = null;
    if (savedEnv === undefined) delete process.env.PORTAL_APP_ENABLED;
    else process.env.PORTAL_APP_ENABLED = savedEnv;
  });

  async function boot(enabled) {
    if (enabled) process.env.PORTAL_APP_ENABLED = 'true';
    else delete process.env.PORTAL_APP_ENABLED;
    server = await bootDashboard();
  }

  it('an admin login cookie is SameSite=Lax even with the app enabled', async () => {
    await boot(true);
    const res = await request(server, { path: '/login', body: {} });
    expect(res.status).toBe(200);
    expect(setCookie(res)).toMatch(/SameSite=Lax/i);
    expect(setCookie(res)).not.toMatch(/SameSite=None/i);
  });

  it('an admin login cookie is Lax even when the request claims the app origin', async () => {
    await boot(true);
    const res = await request(server, { path: '/login', headers: { Origin: APP_ORIGIN }, body: {} });
    expect(setCookie(res)).toMatch(/SameSite=Lax/i);
  });

  it('a portal login from the app origin gets SameSite=None (Secure, HttpOnly) when the app is enabled', async () => {
    await boot(true);
    const res = await portalLogin(server, APP_ORIGIN);
    expect(res.status).toBe(200);
    expect(setCookie(res)).toMatch(/SameSite=None/i);
    expect(setCookie(res)).toMatch(/Secure/);
    expect(setCookie(res)).toMatch(/HttpOnly/);
  });

  it('a first-time portal setup from the app origin gets SameSite=None too', async () => {
    await boot(true);
    const loginUser = mockDb.user;
    mockDb.user = { id: 'u-2', portal_activated: false, portal_invite_expires_at: new Date(Date.now() + 3600e3).toISOString() };
    try {
      const res = await request(server, {
        path: '/api/portal/setup',
        headers: { Origin: APP_ORIGIN },
        body: { token: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', password: 'new-password-1' },
      });
      expect(res.status).toBe(200);
      expect(setCookie(res)).toMatch(/SameSite=None/i);
    } finally {
      mockDb.user = loginUser;
    }
  });

  it('a portal login from the app origin stays Lax when the app is not enabled', async () => {
    await boot(false);
    const res = await portalLogin(server, APP_ORIGIN);
    expect(res.status).toBe(200);
    expect(setCookie(res)).toMatch(/SameSite=Lax/i);
  });

  it('a web portal login stays Lax with the app enabled', async () => {
    await boot(true);
    const res = await portalLogin(server, PORTAL_URL);
    expect(res.status).toBe(200);
    expect(setCookie(res)).toMatch(/SameSite=Lax/i);
  });

  it('an app session that then logs in as admin is re-issued Lax', async () => {
    await boot(true);
    const appLogin = await portalLogin(server, APP_ORIGIN);
    expect(setCookie(appLogin)).toMatch(/SameSite=None/i);

    const admin = await request(server, { path: '/login', headers: { Cookie: cookiePair(appLogin) }, body: {} });
    expect(setCookie(admin)).toMatch(/SameSite=Lax/i);
  });

  it('allows the app origin in credentialed CORS only when the app is enabled', async () => {
    const preflight = () => request(server, {
      method: 'OPTIONS',
      path: '/api/portal/login',
      headers: { Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });

    await boot(true);
    const on = await preflight();
    expect(on.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(on.headers['access-control-allow-credentials']).toBe('true');
    await new Promise((r) => server.close(r));

    await boot(false);
    const off = await preflight();
    expect(off.headers['access-control-allow-origin']).toBeUndefined();
  });
});
