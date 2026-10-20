'use strict';
/**
 * The /observe menu — ONE numbered list.
 *
 *   pending work, oldest first      each row re-enters exactly its own step:
 *     📝 observe_pend_resume_<id>   not at the debrief yet (observe-resume)
 *     📋 observe_pend_debrief_<id>  debrief to do (the debrief step's offer)
 *     📨 observe_pend_send_<id>     report not sent (the send step's offer)
 *   🎙 observe_menu_new             the visit picker (or a bare capture)
 *   📅 observe_menu_sched           my schedule
 *   🗓 observe_menu_plan            plan a visit
 *   observe_menu_more_<page>        the next page of pending work
 *
 * The pending lists come from the debrief step (listPendingDebriefs,
 * listUnsentReports, listUnfinished). That module is required lazily and
 * guarded: when it is absent or a lookup fails, the coach simply sees no
 * pending rows — a dead-ended coach is worse than a hidden backlog that
 * resurfaces next time.
 *
 * Shown when there is pending work or a roster; a coach with neither gets
 * today's bare capture prompt (the caller decides).
 */

const WhatsAppService = require('../whatsapp.service');
const ObserveState = require('./observe-state.service');
const Roster = require('./observe-roster.service');
const { t, observeLang } = require('./observe-strings');
const { row, pageOf, listPayload, fmtDay } = require('./observe-list');
const { logToFile } = require('../../utils/logger');

function _debrief() {
  try {
    // eslint-disable-next-line global-require -- lazy: a failing debrief module hides the pending rows, never the menu
    return require('./observe-debrief.service');
  } catch (err) {
    logToFile('⚠️ observe-menu: debrief step failed to load (pending hidden)', { error: err.message });
    return null;
  }
}

async function _safeList(mod, fn, userId) {
  if (!mod || typeof mod[fn] !== 'function') return [];
  try {
    const rows = await mod[fn](userId);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    logToFile('⚠️ observe-menu: pending lookup failed (rows hidden)', { userId, fn, error: err.message });
    return [];
  }
}

/** Every pending item, oldest first: [{kind, id, created_at, name, resume}]. */
async function loadPending(userId) {
  const D = _debrief();
  const [unfinished, debriefs, unsent] = await Promise.all([
    _safeList(D, 'listUnfinished', userId),
    _safeList(D, 'listPendingDebriefs', userId),
    _safeList(D, 'listUnsentReports', userId),
  ]);
  const seen = new Set();
  const items = [];
  const add = (kind, r) => {
    if (!r || !r.id || seen.has(r.id)) return;
    seen.add(r.id);
    const delivery = (r.analysis_data && r.analysis_data.teacher_delivery) || {};
    items.push({ kind, id: r.id, created_at: r.created_at || '', name: r.teacher_name || delivery.teacher_name || null, resume: r.resume || null });
  };
  unfinished.forEach((r) => add('resume', r));
  debriefs.forEach((r) => add('debrief', r));
  unsent.forEach((r) => add('send', r));
  return items.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

const ICON = { resume: '📝', debrief: '📋', send: '📨' };

function _pendingRow(lang, item) {
  const day = item.created_at ? fmtDay(item.created_at) : '';
  const title = `${ICON[item.kind]} ${item.name || day || t(lang, 'pend_row_fallback')}`;
  let what;
  if (item.kind === 'resume') what = t(lang, `resume_desc_${item.resume || 'retry'}`);
  else what = t(lang, item.kind === 'debrief' ? 'pend_debrief_desc' : 'pend_send_desc');
  return row(`observe_pend_${item.kind}_${item.id}`, title, [what, item.name ? day : null].filter(Boolean).join(' · '));
}

async function _scheduleDesc(lang, userId) {
  try {
    const ScheduleStore = require('./observe-schedule.service');
    const visits = await ScheduleStore.listUpcoming(userId);
    if (!visits.length) return t(lang, 'menu_schedule_desc');
    return t(lang, 'menu_schedule_desc_count', { n: visits.length, overdue: visits.filter((v) => v.overdue).length });
  } catch (_) {
    return t(lang, 'menu_schedule_desc');
  }
}

/** The menu payload. Pure apart from the schedule count. */
async function buildMenu(user, { pending, hasRoster, page = 0 }) {
  const lang = observeLang(user);
  const actions = [row('observe_menu_new', t(lang, 'list_new_observation'), t(lang, 'list_new_observation_desc'))];
  if (hasRoster) {
    actions.push(row('observe_menu_sched', t(lang, 'menu_schedule'), await _scheduleDesc(lang, user.id)));
    actions.push(row('observe_menu_plan', t(lang, 'menu_plan'), t(lang, 'menu_plan_desc')));
  }
  const { items, hasMore } = pageOf(pending, page, actions.length);
  const pendingRows = items.map((it) => _pendingRow(lang, it));
  if (hasMore) pendingRows.push(row(`observe_menu_more_${page + 1}`, t(lang, 'menu_more'), t(lang, 'menu_more_desc')));
  return listPayload(
    t(lang, pending.length ? 'menu_body_pending' : 'menu_body'),
    t(lang, 'list_button'),
    [{ title: t(lang, 'menu_section_pending'), rows: pendingRows }, { title: t(lang, 'menu_section_actions'), rows: actions }],
  );
}

/**
 * /observe after the gates. A stale armed recording slot is cleared first —
 * /observe means "start over", and an old pick must never bind a new lesson.
 * Mid-step states owned by other steps (the debrief recording, the form) are
 * left alone.
 */
async function openMenu(user, from, page = 0) {
  try {
    const st = await ObserveState.getState(user.id);
    if (st && ['awaiting_audio', 'awaiting_visit_date', 'awaiting_pick'].includes(st.state)) await ObserveState.clearState(user.id);
  } catch (_) { /* nothing to clear */ }

  const [pending, hasRoster] = await Promise.all([loadPending(user.id), Roster.hasAssignment(user.id)]);
  if (!pending.length && !hasRoster) {
    const Visit = require('./observe-visit.service');
    return Visit.sendBareCapture(user, from);
  }
  await WhatsAppService.sendInteractiveMessage(from, await buildMenu(user, { pending, hasRoster, page }));
  logToFile('🔭 observe-menu: menu sent', { userId: user.id, pending: pending.length, hasRoster, page });
  return true;
}

async function onMoreTap(user, from, rest) {
  if (!/^\d+$/.test(String(rest))) return false;
  const [pending, hasRoster] = await Promise.all([loadPending(user.id), Roster.hasAssignment(user.id)]);
  await WhatsAppService.sendInteractiveMessage(from, await buildMenu(user, { pending, hasRoster, page: parseInt(rest, 10) }));
  return true;
}

/** "New observation": the picker when the coach has a roster, else a bare capture. */
async function onNewTap(user, from) {
  const Visit = require('./observe-visit.service');
  if (await Roster.hasAssignment(user.id)) return Visit.startPicker(user, from, 'o');
  return Visit.sendBareCapture(user, from);
}

/**
 * A pending row: `<kind>_<sessionId>`. Each kind has exactly one branch; a
 * step whose module is not available answers plainly instead of crashing.
 */
async function onPendingTap(user, from, rest) {
  const m = /^(resume|debrief|send)_(.+)$/.exec(String(rest || ''));
  if (!m) return false;
  const [, kind, sessionId] = m;
  if (kind === 'resume') return require('./observe-resume.service').resume(sessionId, from, user);
  try {
    // eslint-disable-next-line global-require -- lazy: both steps reach back into this graph
    const mod = kind === 'debrief' ? require('./observe-debrief.service') : require('./observe-send.service');
    const fn = kind === 'debrief' ? 'offerDebriefChoice' : 'offerSendReport';
    if (!mod || typeof mod[fn] !== 'function') throw new Error(`${fn} not available`);
    await mod[fn](user, from, sessionId);
  } catch (err) {
    logToFile('⚠️ observe-menu: pending step unavailable', { userId: user.id, kind, sessionId, error: err.message });
    await WhatsAppService.sendMessage(from, t(observeLang(user), 'pend_unavailable'));
  }
  return true;
}

module.exports = { loadPending, buildMenu, openMenu, onMoreTap, onNewTap, onPendingTap };
