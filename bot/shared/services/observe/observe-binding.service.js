'use strict';
/**
 * Explicit audio → observation binding ("whose observation is this?").
 *
 * A coach's classroom-length recording with nothing armed is PARKED and the
 * coach is asked one list question. The park is a FIFO per coach, stored as a
 * JSON array under ONE Redis key (the cache service has no list operations),
 * 6h TTL — the TTL is about conversation freshness, not media expiry. A coach
 * who records two classes before answering loses neither: a single slot would
 * silently overwrite the first. Binding always consumes the OLDEST entry, and
 * the question re-asks while more remain.
 *
 * Every row id carries the parked recording's own token
 * (observe_bind_<token>_<kind>[_<arg>]), so a tap always means "THIS
 * recording" — a double tap or a webhook retry can never bind the next one by
 * accident. A setNX bind lock per token makes the bind exactly-once; an
 * identical re-send (same sha256, or the same media id) is answered "already
 * got this one" instead of starting a second pipeline.
 *
 *   kinds: v_<scheduleId>  a scheduled visit (listed first)
 *          t_<teacherId>   a roster teacher
 *          o               another teacher → the school → teacher picker (mode b)
 *          d               this is a debrief → dbr_<sessionId> picks which one
 *          self            my own lesson (only leaders who may self-coach)
 *          no              not an observation → dropped
 *
 * Binding creates the session through the normal armed capture
 * (ObserveCapture.startFromAudio with boundTeacher armed), so teacher
 * ownership, schedule markDone and the capture ack are identical to a
 * recording sent after the picker.
 */

const crypto = require('crypto');
const redisService = require('../cache/railway-redis.service');
const WhatsAppService = require('../whatsapp.service');
const ObserveState = require('./observe-state.service');
const Roster = require('./observe-roster.service');
const { t, observeLang } = require('./observe-strings');
const { canSelfCoach } = require('./observe-gate');
const { row, listPayload, fmtDay } = require('./observe-list');
const { logToFile } = require('../../utils/logger');
/** The debrief step — required lazily, it reaches back into the capture graph. */
// eslint-disable-next-line global-require
const _debriefStep = () => require('./observe-debrief.service');

const PARK_TTL_S = 6 * 3600;
const RECENT_TTL_S = 24 * 3600;
const BIND_LOCK_TTL_S = 300;
const PARK_CAP = 5;
const PREFIX = 'observe_bind_';

const parkKey = (userId) => `observe:parked:${userId}`;
const recentKey = (userId, token) => `observe:bound:${userId}:${token}`;
const lockKey = (userId, token) => `observe:bindlock:${userId}:${token}`;

/** A short, id-safe token for one recording: its bytes when known, else its media id. */
function tokenOf(entry) {
  const basis = (entry && (entry.sha256 || entry.audioId)) || '';
  return crypto.createHash('sha1').update(String(basis)).digest('hex').slice(0, 12);
}

const _parse = (raw) => (raw && typeof raw === 'string' ? JSON.parse(raw) : raw);

async function _readQueue(userId) {
  try {
    const val = _parse(await redisService.get(parkKey(userId)));
    if (!val) return [];
    return Array.isArray(val) ? val : [val];
  } catch (err) {
    logToFile('⚠️ observe-binding: unreadable park, treating as empty', { userId, error: err.message });
    return [];
  }
}

async function _writeQueue(userId, queue) {
  if (!queue.length) return redisService.delete(parkKey(userId));
  return redisService.setexWithCeiling(parkKey(userId), PARK_TTL_S, JSON.stringify(queue));
}

async function _recent(userId, token) {
  try {
    const rec = _parse(await redisService.get(recentKey(userId, token)));
    return rec && typeof rec === 'object' ? rec : (rec ? { sessionId: rec } : null);
  } catch (_) {
    return null;
  }
}

async function _remember(userId, token, rec) {
  try {
    await redisService.setexWithCeiling(recentKey(userId, token), RECENT_TTL_S, JSON.stringify(rec));
  } catch (_) { /* dedupe memory is best-effort */ }
}

async function _dupeAck(user, from, rec) {
  const lang = observeLang(user);
  const name = (rec && rec.teacherName) || t(lang, 'bind_dupe_fallback_name');
  await WhatsAppService.sendMessage(from, t(lang, 'bind_dupe_ack', { name }));
}

/** Remember a recording the armed path captured, so an identical re-send is a dupe. */
async function rememberCaptured(userId, { audioId, sha256 }, session, teacherName = null) {
  if (!userId || !session) return;
  await _remember(userId, tokenOf({ audioId, sha256 }), { sessionId: session.id, teacherName });
}

/** Is anything parked for this coach? The OLDEST entry's token, or null. */
async function headToken(userId) {
  const queue = await _readQueue(userId);
  return queue.length ? tokenOf(queue[0]) : null;
}

/**
 * Park an unbound recording and ask whose it is.
 * @returns {Promise<{action: 'asked'|'queued'|'dupe'|'park_full'}>}
 */
async function parkAndAsk(user, from, {
  audioId, sha256 = null, durationSeconds = null, mimeType = null, sessionId = null,
}) {
  const lang = observeLang(user);
  const entry = { audioId, sha256, durationSeconds, mimeType, sessionId, parkedAt: new Date().toISOString() };
  const token = tokenOf(entry);

  // Identical bytes (or the same upload) already bound recently → point at it.
  const rec = await _recent(user.id, token);
  if (rec) {
    await _dupeAck(user, from, rec);
    logToFile('🔁 observe-binding: duplicate recording answered as dupe', { userId: user.id, sessionId: rec.sessionId });
    return { action: 'dupe' };
  }

  const queue = await _readQueue(user.id);
  if (queue.some((q) => tokenOf(q) === token)) {
    await _dupeAck(user, from, null);
    return { action: 'dupe' };
  }
  if (queue.length >= PARK_CAP) {
    await WhatsAppService.sendMessage(from, t(lang, 'bind_park_full'));
    return { action: 'park_full' };
  }
  queue.push(entry);
  await _writeQueue(user.id, queue);
  logToFile('🅿️ observe-binding: recording parked', { userId: user.id, audioId, queued: queue.length, durationSeconds });

  // The open question is about the OLDEST recording; a later one waits its turn.
  if (queue.length > 1) {
    await WhatsAppService.sendMessage(from, t(lang, 'bind_queued'));
    return { action: 'queued' };
  }
  await WhatsAppService.sendInteractiveMessage(from, await buildBindingList(user, queue[0]));
  return { action: 'asked' };
}

/** Scheduled teachers first, then the roster, then the fixed choices. */
async function buildBindingList(user, head) {
  const lang = observeLang(user);
  const tok = tokenOf(head);
  const id = (kind) => `${PREFIX}${tok}_${kind}`;

  const fixed = [row(id('o'), t(lang, 'bind_row_other'), t(lang, 'bind_row_other_desc'))];
  try {
    const Debrief = _debriefStep();
    const pendings = Debrief ? await Debrief.listPendingDebriefs(user.id, { limit: 1 }) : [];
    if (pendings && pendings.length) fixed.push(row(id('d'), t(lang, 'bind_row_debrief'), t(lang, 'bind_row_debrief_desc')));
  } catch (_) { /* no debrief step available — the row is simply absent */ }
  // A leader who also teaches can say "this one is mine"; a full-time coach
  // never sees the row (their classroom audio is always an observation).
  if (canSelfCoach(user)) fixed.push(row(id('self'), t(lang, 'bind_row_self_dc'), t(lang, 'bind_row_self_dc_desc')));
  fixed.push(row(id('no'), t(lang, 'bind_row_not_obs'), t(lang, 'bind_row_not_obs_desc')));

  const room = 10 - fixed.length;
  const people = [];
  const seen = new Set();
  try {
    const ScheduleStore = require('./observe-schedule.service');
    for (const v of await ScheduleStore.listUpcoming(user.id)) {
      if (people.length >= room) break;
      seen.add(v.teacher_ext_id);
      people.push(row(id(`v_${v.id}`), `📋 ${v.teacher_name || t(lang, 'bind_row_visit_fallback')}`,
        [v.school_name, fmtDay(v.scheduled_for)].filter(Boolean).join(' · ')));
    }
  } catch (err) {
    logToFile('⚠️ observe-binding: schedule lookup failed (list degrades)', { userId: user.id, error: err.message });
  }
  try {
    for (const tc of await Roster.listTeachers(user.id)) {
      if (people.length >= room) break;
      if (seen.has(tc.teacher_ext_id)) continue;
      people.push(row(id(`t_${tc.user_id}`), tc.name, tc.school_name || ''));
    }
  } catch (_) { /* roster unavailable — "another teacher" still works */ }

  const sections = [
    { title: t(lang, 'bind_section_title'), rows: people },
    { title: t(lang, 'menu_section_actions'), rows: fixed },
  ];
  if (!people.length) sections[1].title = t(lang, 'bind_section_title');
  return listPayload(t(lang, 'bind_prompt_body'), t(lang, 'bind_button'), sections);
}

async function _reask(user, from) {
  try {
    const queue = await _readQueue(user.id);
    if (queue.length) await WhatsAppService.sendInteractiveMessage(from, await buildBindingList(user, queue[0]));
  } catch (err) {
    logToFile('⚠️ observe-binding: re-ask failed (the next recording stays parked)', { userId: user.id, error: err.message });
  }
}

/**
 * The head of the park IF the tap is about it. Otherwise answers the coach
 * (dupe when that recording was already bound, expired when it is gone) and
 * returns null.
 */
async function _claimHead(user, from, token) {
  const queue = await _readQueue(user.id);
  const head = queue[0];
  if (head && tokenOf(head) === token) return { head, queue };
  const rec = await _recent(user.id, token);
  if (rec) await _dupeAck(user, from, rec);
  else await WhatsAppService.sendMessage(from, t(observeLang(user), 'bind_expired'));
  return null;
}

/** Retire the head (it was consumed), then re-ask for the next one. */
async function _consumed(user, from, token, rec) {
  const queue = await _readQueue(user.id);
  if (queue.length && tokenOf(queue[0]) === token) queue.shift();
  await _writeQueue(user.id, queue);
  if (rec) await _remember(user.id, token, rec);
  if (queue.length) await _reask(user, from);
}

/**
 * Capture the parked recording `token` for `boundTeacher` (null = unbound;
 * capture then asks who it was). Exactly once per token.
 * @returns {Promise<boolean>} true — the tap was ours
 */
async function bindTeacher(user, from, { token, boundTeacher = null }) {
  if (!token) {
    await WhatsAppService.sendMessage(from, t(observeLang(user), 'bind_expired'));
    return true;
  }
  const claim = await _claimHead(user, from, token);
  if (!claim) return true;
  if (!(await redisService.setNX(lockKey(user.id, token), '1', BIND_LOCK_TTL_S))) {
    await _dupeAck(user, from, await _recent(user.id, token));
    return true;
  }
  const { head } = claim;
  await ObserveState.setState(user.id, 'awaiting_audio', boundTeacher ? { boundTeacher } : {});
  const ObserveCapture = require('./observe-capture.service');
  const session = await ObserveCapture.startFromAudio(user, from, head.audioId, head.sessionId || null, head.durationSeconds || null);
  if (!session) {
    // capture already told the coach it failed; free the lock so a retry can work
    await redisService.delete(lockKey(user.id, token));
    return true;
  }
  const teacherName = (boundTeacher && boundTeacher.name) || null;
  if (teacherName) await WhatsAppService.sendMessage(from, t(observeLang(user), 'bind_ack', { name: teacherName }));
  await _consumed(user, from, token, { sessionId: session.id, teacherName });
  logToFile('✅ observe-binding: parked recording bound and captured', { userId: user.id, sessionId: session.id });
  return true;
}

async function _onVisit(user, from, token, scheduleId) {
  const ScheduleStore = require('./observe-schedule.service');
  const visit = await ScheduleStore.getUpcoming(user.id, scheduleId);
  if (!visit) {
    await WhatsAppService.sendMessage(from, t(observeLang(user), 'bind_expired'));
    return true;
  }
  const teacher = (await Roster.listTeachers(user.id)).find((tc) => tc.user_id === visit.teacher_ext_id);
  const boundTeacher = teacher
    ? Roster.boundTeacherOf(teacher, visit.school_ext_id)
    : { user_id: null, teacher_ext_id: visit.teacher_ext_id, school_ext_id: visit.school_ext_id, school_id: visit.school_id || null, name: visit.teacher_name, phone: null };
  return bindTeacher(user, from, { token, boundTeacher });
}

async function _onTeacher(user, from, token, teacherId) {
  const teacher = (await Roster.listTeachers(user.id)).find((tc) => tc.user_id === teacherId);
  if (!teacher) {
    await WhatsAppService.sendMessage(from, t(observeLang(user), 'pick_stale'));
    return true;
  }
  return bindTeacher(user, from, { token, boundTeacher: Roster.boundTeacherOf(teacher) });
}

/** "This is a debrief": which waiting observation is it for? */
async function _onDebriefRow(user, from, token) {
  const lang = observeLang(user);
  if (!(await _claimHead(user, from, token))) return true;
  let pendings = [];
  try {
    const Debrief = _debriefStep();
    pendings = Debrief ? await Debrief.listPendingDebriefs(user.id) : [];
  } catch (_) { pendings = []; }
  if (!pendings || !pendings.length) {
    await WhatsAppService.sendMessage(from, t(lang, 'pend_unavailable'));
    return true;
  }
  const rows = pendings.slice(0, 10).map((p) => row(
    `${PREFIX}${token}_dbr_${p.id}`,
    `📋 ${p.teacher_name || fmtDay(p.created_at, { weekday: false })}`,
    [fmtDay(p.created_at), p.school_name].filter(Boolean).join(' · '),
  ));
  await WhatsAppService.sendInteractiveMessage(from, listPayload(
    t(lang, 'bind_debrief_pick_body'), t(lang, 'bind_debrief_pick_button'),
    [{ title: t(lang, 'bind_debrief_pick_section'), rows }],
  ));
  return true;
}

/** The parked recording IS this observation's debrief — hand it to the debrief step. */
async function _onDebriefPick(user, from, token, sessionId) {
  const claim = await _claimHead(user, from, token);
  if (!claim) return true;
  const Debrief = _debriefStep();
  const pendings = Debrief ? await Debrief.listPendingDebriefs(user.id, { limit: 50 }).catch(() => []) : [];
  if (!Debrief || !(pendings || []).some((p) => p.id === sessionId)) {
    await WhatsAppService.sendMessage(from, t(observeLang(user), 'debrief_not_yours'));
    return true;
  }
  if (!(await redisService.setNX(lockKey(user.id, token), '1', BIND_LOCK_TTL_S))) {
    await _dupeAck(user, from, await _recent(user.id, token));
    return true;
  }
  const { head } = claim;
  await Debrief.startDebriefFromAudio(user, from, head.audioId,
    { state: 'awaiting_debrief_audio', sessionId }, { mimeType: head.mimeType || null });
  await _consumed(user, from, token, { sessionId, teacherName: null });
  logToFile('🎙 observe-binding: parked recording handed to the debrief', { userId: user.id, sessionId });
  return true;
}

/** "My own lesson": the leader's own coaching entry (it has its own Yes/No confirm). */
async function _onSelf(user, from, token) {
  if (!canSelfCoach(user)) return _onNotObservation(user, from, token);
  const claim = await _claimHead(user, from, token);
  if (!claim) return true;
  if (!(await redisService.setNX(lockKey(user.id, token), '1', BIND_LOCK_TTL_S))) return true;
  const { head } = claim;
  const CoachingService = require('../coaching-orchestrator.service');
  await CoachingService.initiateCoachingSession(user.id, head.sessionId || null, head.audioId, from, head.durationSeconds || null);
  await _consumed(user, from, token, null);
  logToFile("🎓 observe-binding: parked recording routed to the leader's own coaching", { userId: user.id });
  return true;
}

async function _onNotObservation(user, from, token) {
  const claim = await _claimHead(user, from, token);
  if (!claim) return true;
  await WhatsAppService.sendMessage(from, t(observeLang(user), 'bind_not_obs_ack'));
  await _consumed(user, from, token, null);
  return true;
}

/**
 * Every observe_bind_ tap except "another teacher" (the interactive handler
 * sends that one to the picker). `rest` = `<token>_<kind>[_<arg>]`.
 */
async function onBindTap(user, from, rest) {
  const m = /^([0-9a-f]{12})_(v|t|dbr|d|self|no)(?:_(.+))?$/.exec(String(rest || ''));
  if (!m) return false;
  const [, token, kind, arg] = m;
  if (kind === 'v' && arg) return _onVisit(user, from, token, arg);
  if (kind === 't' && arg) return _onTeacher(user, from, token, arg);
  if (kind === 'dbr' && arg) return _onDebriefPick(user, from, token, arg);
  if (kind === 'd') return _onDebriefRow(user, from, token);
  if (kind === 'self') return _onSelf(user, from, token);
  if (kind === 'no') return _onNotObservation(user, from, token);
  return false;
}

/** `<token>_o` → the token, or null. Used by the handler for "another teacher". */
function parseOtherTap(rest) {
  const m = /^([0-9a-f]{12})_o$/.exec(String(rest || ''));
  return m ? m[1] : null;
}

module.exports = {
  parkAndAsk, buildBindingList, bindTeacher, onBindTap, parseOtherTap, headToken, rememberCaptured, tokenOf, PARK_CAP,
};
