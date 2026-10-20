/**
 * Portal API for the coach's view, mounted on the real portal router.
 *
 *   GET /api/portal/coach/observations   upcoming / waiting / completed
 *   GET /api/portal/coach/teachers       the derived roster
 *   GET /api/portal/coach/teacher/:id    one roster teacher's observations
 *
 * Coaches only (the observe role family): a teacher gets 403, no session 401.
 * Only while observe is on (OBSERVE_ENABLED=true, not paused by
 * RUMI_FEATURE_OBSERVE=off): off, the coach endpoints are 404 and nobody is a
 * coach, exactly as before the feature. A database failure is a 500, never a
 * 200 with empty lists ("Nothing waiting. You're up to date.").
 * /dashboard tells the client whether to show the nav item (user.isCoach).
 * And the teacher-facing endpoints never surface a leader observation — its
 * score is the coach's rating, so a teacher must not see it on their portal.
 */

const http = require('http');
const express = require('express');
const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', first_name: 'Robin', name: 'Robin Coach', phone_number: '15550100001' },
    { id: 't-1', first_name: 'Sam', name: 'Sam Taylor', phone_number: '15550100002', school_id: 'sch-1' },
    { id: 't-9', first_name: 'Jo', name: 'Jo Park', phone_number: '15550100009', school_id: 'sch-9' },
  ],
  leader_schools: [
    { id: 'ls-1', leader_user_id: 'coach-1', school_id: 'sch-1', school_name: 'Hillside Primary' },
  ],
  observation_schedules: [
    { id: 'sc-1', leader_user_id: 'coach-1', teacher_ext_id: 't-1', teacher_name: 'Sam Taylor', school_name: 'Hillside Primary', scheduled_for: '2000-01-01', status: 'upcoming', created_at: '2000-01-01T00:00:00Z' },
  ],
  coaching_sessions: [
    { id: 'cs-obs', observation_type: 'leader_observation', observer_user_id: 'coach-1', user_id: 't-1', status: 'completed', debrief_status: 'done', created_at: '2026-03-08T09:00:00Z',
      analysis_data: { scores: { overall_marks: 40, percentage: 33 }, observer_debrief: { feedback: 'Coach-only note.' }, teacher_delivery: { status: 'sent' } } },
    { id: 'cs-own', observation_type: null, user_id: 't-1', status: 'completed', created_at: '2026-03-01T09:00:00Z',
      analysis_data: { scores: { overall_marks: 90, percentage: 76 } } },
  ],
});

jest.mock('../../dashboard/config/supabase', () => mockDb.client);
jest.mock('bcryptjs', () => ({ compare: jest.fn(), hash: jest.fn() }), { virtual: true });
jest.mock('express-rate-limit', () => () => (req, res, next) => next(), { virtual: true });

const portalRoutes = require('../../dashboard/routes/portal.routes');

let server;
let base;
let sessionUser = null;

beforeAll((done) => {
  const app = express();
  app.use((req, res, next) => { req.session = sessionUser ? { portalUserId: sessionUser, id: 'sess' } : {}; next(); });
  app.use('/api/portal', portalRoutes);
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
const realFrom = mockDb.client.from;
beforeEach(() => {
  process.env.OBSERVE_ENABLED = 'true';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.OBSERVE_ENABLED;
  delete process.env.RUMI_FEATURE_OBSERVE;
  mockDb.client.from = realFrom;
  jest.restoreAllMocks();
});

// Every query on the named tables answers a PostgREST error, as a dashboard
// deployed before its migration would see.
function failTables(names) {
  const failing = () => {
    const q = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          return (resolve) => resolve({ data: null, error: { message: 'column coaching_sessions.observation_type does not exist' } });
        }
        return () => q;
      },
    });
    return q;
  };
  mockDb.client.from = (name) => (names.includes(name) ? failing() : realFrom(name));
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (_) { /* express's HTML 404 */ }
        resolve({ status: res.statusCode, body: json, raw: body });
      });
    }).on('error', reject);
  });
}

describe('coach endpoints', () => {
  test('no session -> 401', async () => {
    sessionUser = null;
    expect((await get('/api/portal/coach/observations')).status).toBe(401);
  });

  test('a teacher (not in the role family) -> 403 on every coach endpoint', async () => {
    sessionUser = 't-1';
    for (const p of ['/coach/observations', '/coach/teachers', '/coach/teacher/t-1']) {
      const res = await get(`/api/portal${p}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    }
  });

  test('a coach gets their observations, with no score and no coach-the-coach feedback', async () => {
    sessionUser = 'coach-1';
    const res = await get('/api/portal/coach/observations');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.observations.upcoming[0]).toMatchObject({ id: 'sc-1', teacherName: 'Sam Taylor', overdue: true });
    expect(res.body.observations.completed.map((o) => o.id)).toEqual(['cs-obs']);
    expect(res.raw).not.toMatch(/Coach-only|overall_marks|percentage|score/i);
  });

  test('a coach gets their roster and one roster teacher; anyone else is 404', async () => {
    sessionUser = 'coach-1';
    const list = await get('/api/portal/coach/teachers');
    expect(list.status).toBe(200);
    expect(list.body.teachers).toEqual([
      { id: 't-1', name: 'Sam Taylor', schoolName: 'Hillside Primary', observationCount: 1, lastObservedAt: '2026-03-08T09:00:00Z' },
    ]);
    const one = await get('/api/portal/coach/teacher/t-1');
    expect(one.status).toBe(200);
    expect(one.body.teacher.name).toBe('Sam Taylor');
    expect(one.body.observations.map((o) => o.id)).toEqual(['cs-obs']);
    expect((await get('/api/portal/coach/teacher/t-9')).status).toBe(404);
  });
});

describe('a database failure is an error, not an empty answer', () => {
  test('observations: 500 {success:false}, not 200 with empty lists', async () => {
    sessionUser = 'coach-1';
    failTables(['coaching_sessions']);
    const res = await get('/api/portal/coach/observations');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.observations).toBeUndefined();
  });

  test('observations: a failing schedules read is a 500 too', async () => {
    sessionUser = 'coach-1';
    failTables(['observation_schedules']);
    expect((await get('/api/portal/coach/observations')).status).toBe(500);
  });

  test('roster and teacher detail: 500 on any failing read, never a short or uncounted roster', async () => {
    sessionUser = 'coach-1';
    for (const table of ['leader_schools', 'coaching_sessions', 'observation_schedules']) {
      failTables([table]);
      const list = await get('/api/portal/coach/teachers');
      expect([table, list.status, list.body.success]).toEqual([table, 500, false]);
      const one = await get('/api/portal/coach/teacher/t-1');
      expect([table, one.status, one.body.success]).toEqual([table, 500, false]);
    }
  });

  test('the coach check itself failing is a 500, not "this area is for coaches"', async () => {
    sessionUser = 'coach-1';
    failTables(['users']);
    const res = await get('/api/portal/coach/observations');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('OBSERVE_ENABLED gates the coach view on the dashboard too', () => {
  test('unset: every coach endpoint is 404 and the coach is not a coach on /dashboard', async () => {
    delete process.env.OBSERVE_ENABLED;
    sessionUser = 'coach-1';
    for (const p of ['/coach/observations', '/coach/teachers', '/coach/teacher/t-1']) {
      const res = await get(`/api/portal${p}`);
      expect([p, res.status]).toEqual([p, 404]);
      expect(res.body.success).toBe(false);
    }
    expect((await get('/api/portal/dashboard')).body.user.isCoach).toBe(false);
  });

  test('anything but "true" is off; the console pause (RUMI_FEATURE_OBSERVE=off) is off', async () => {
    sessionUser = 'coach-1';
    for (const v of ['1', 'yes', 'false', '']) {
      process.env.OBSERVE_ENABLED = v;
      expect([v, (await get('/api/portal/coach/teachers')).status]).toEqual([v, 404]);
    }
    process.env.OBSERVE_ENABLED = ' TRUE ';
    expect((await get('/api/portal/coach/teachers')).status).toBe(200);
    process.env.RUMI_FEATURE_OBSERVE = 'off';
    expect((await get('/api/portal/coach/teachers')).status).toBe(404);
    expect((await get('/api/portal/dashboard')).body.user.isCoach).toBe(false);
  });

  test('set: the coach view is there, read at call time', async () => {
    sessionUser = 'coach-1';
    expect((await get('/api/portal/coach/observations')).status).toBe(200);
    expect((await get('/api/portal/dashboard')).body.user.isCoach).toBe(true);
  });
});

describe('teacher-facing endpoints', () => {
  test('/dashboard says whether the user is a coach', async () => {
    sessionUser = 'coach-1';
    expect((await get('/api/portal/dashboard')).body.user.isCoach).toBe(true);
    sessionUser = 't-1';
    expect((await get('/api/portal/dashboard')).body.user.isCoach).toBe(false);
  });

  test('a teacher never sees an observation of them (the coach\'s ratings) as their own session', async () => {
    sessionUser = 't-1';
    const list = await get('/api/portal/coaching-sessions');
    expect(list.body.sessions.map((s) => s.id)).toEqual(['cs-own']);

    expect((await get('/api/portal/coaching-session/cs-obs')).status).toBe(404);
    expect((await get('/api/portal/coaching-session/cs-own')).status).toBe(200);

    const analytics = await get('/api/portal/coaching-analytics');
    expect(analytics.body.analytics.insights.totalSessions).toBe(1);

    const dash = await get('/api/portal/dashboard');
    expect(dash.body.recentCoachingSession.id).toBe('cs-own');
  });
});
