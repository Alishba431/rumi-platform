/**
 * Portal API — the coach's view ("My observations").
 *
 * Mounted by portal.routes.js under /api/portal:
 *   GET /coach/observations   upcoming + overdue visits, what is waiting on the
 *                             coach (form / debrief / report), in progress, done
 *   GET /coach/teachers       the coach's derived roster with observation counts
 *   GET /coach/teacher/:id    one roster teacher and their past observations
 *
 * Only while observe is on (OBSERVE_ENABLED=true on the dashboard service, not
 * paused with RUMI_FEATURE_OBSERVE=off): off, every route here is a 404, as if
 * the feature were not installed. Coaches only — the observe role family
 * (OBSERVE_LEADER_ROLES). The coach id always comes from the session, never the
 * request. Payloads carry no score and no coach-the-coach feedback (see
 * coach-observations.service.js). A failed read is a 500, never an empty 200:
 * empty lists would tell the coach they are up to date.
 */

const express = require('express');
const Coach = require('../services/coach-observations.service');

/**
 * @param {{db: object, requireAuth: Function}} deps the supabase client and the
 *   portal's session middleware (sets nothing; 401s when not logged in)
 */
function createCoachRouter({ db, requireAuth }) {
  const router = express.Router();

  // Off means not there — checked before auth, read at call time.
  function requireObserveOn(req, res, next) {
    if (!Coach.isObserveEnabled()) return res.status(404).json({ success: false, error: 'Not found.' });
    return next();
  }

  // Server-side gate: client nav hiding is only UX.
  async function requireCoach(req, res, next) {
    try {
      const { data: user, error } = await db
        .from('users')
        .select('id, role')
        .eq('id', req.session.portalUserId)
        .maybeSingle();
      // A failed lookup is not "not a coach".
      if (error) throw new Error(error.message);
      if (!Coach.isCoach(user)) {
        return res.status(403).json({ success: false, error: 'This area is for coaches only.' });
      }
      return next();
    } catch (err) {
      console.error('coach gate lookup failed:', err.message);
      return res.status(500).json({ success: false, error: 'Could not verify access. Please try again.' });
    }
  }

  router.get('/coach/observations', requireObserveOn, requireAuth, requireCoach, async (req, res) => {
    try {
      const observations = await Coach.getCoachObservations(db, req.session.portalUserId);
      res.json({ success: true, observations });
    } catch (err) {
      console.error('coach/observations error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to load your observations.' });
    }
  });

  router.get('/coach/teachers', requireObserveOn, requireAuth, requireCoach, async (req, res) => {
    try {
      const teachers = await Coach.listCoachTeachers(db, req.session.portalUserId);
      res.json({ success: true, teachers });
    } catch (err) {
      console.error('coach/teachers error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to load your teachers.' });
    }
  });

  router.get('/coach/teacher/:id', requireObserveOn, requireAuth, requireCoach, async (req, res) => {
    try {
      const detail = await Coach.getCoachTeacher(db, req.session.portalUserId, req.params.id);
      if (!detail) return res.status(404).json({ success: false, error: 'Teacher not found.' });
      res.json({ success: true, ...detail });
    } catch (err) {
      console.error('coach/teacher error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to load this teacher.' });
    }
  });

  return router;
}

module.exports = { createCoachRouter };
