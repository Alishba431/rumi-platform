/**
 * data_exchange endpoint for the editable observation form (Meta Flow).
 *
 * Meta only: every other channel reviews the same ratings in the stepwise chat
 * form (services/observe/observe-form.service.js). Both surfaces write through
 * the one merge, observe-edits.service applyObserverEdits.
 *
 * Contract:
 * - NEVER include a `version` field in any response.
 * - Every returned field must be declared in the screen's data object; the
 *   Flow JSON is generated from the same framework pack
 *   (scripts/generate-observe-flow-json.js), so the bindings agree.
 * - Meta waits ~10 s: this endpoint only READS the pre-computed draft and
 *   buffers edits — the expensive analysis ran before the Flow was sent.
 * - Forward-only routing; BACK re-serves a screen's prefill.
 *
 * Edit accumulation: each screen submit buffers its r_/ev_/imp_ values in
 * Redis (observe:edits:<sessionId>, 2h TTL). The final screen submit merges
 * everything and writes v2. Redis loss degrades gracefully: lost screens
 * simply keep the v1 values (no edit recorded).
 *
 * Identity comes from the flow token `<observerId>:<sessionId>` that
 * observe-draft.service minted when it sent the Flow — never from a phone
 * number in the request.
 */

const supabase = require('../config/supabase');
const redisService = require('../services/cache/railway-redis.service');
const { t } = require('../services/observe/observe-strings');
const ObserveDraft = require('../services/observe/observe-draft.service');
const ObserveEdits = require('../services/observe/observe-edits.service');
const { getObservePack, formScreens } = require('../services/observe/observe-framework');
const { isTerminalStatus } = require('../services/observe/observe-terminal');
const { logToFile } = require('../utils/logger');

const EDITS_TTL = 7200;
const editsKey = (sessionId) => `observe:edits:${sessionId}`;

// Screens and domain order come from the configured framework pack, read per
// request so one build serves any pack.
function screens() {
  const list = formScreens(getObservePack());
  return {
    ids: list.map((s) => s.id),
    domainOf: (id) => (list.find((s) => s.id === id) || {}).domainKey,
    first: list[0].id,
    last: list[list.length - 1].id,
    next: (id) => {
      const i = list.findIndex((s) => s.id === id);
      return i >= 0 && i < list.length - 1 ? list[i + 1].id : 'SUCCESS';
    },
  };
}

function errorResponse(message) {
  return { data: { error: true, error_message: message } };
}

function screenResponse(session, screenId) {
  return {
    screen: screenId,
    data: ObserveDraft.buildScreenPrefill(session.analysis_data, screens().domainOf(screenId)),
  };
}

/**
 * One refusal notice per observation per window. A Flow message stays
 * tappable, so a coach can hit a cancelled form several times in seconds and
 * must be told once, not once per tap.
 */
const REFUSAL_NOTICE_TTL_S = 300;
const refusalNoticeKey = (sessionId) => `observe:refused_notice:${sessionId}`;

async function coachLanguage(session) {
  try {
    const { languageFor } = require('../services/observe/observe-language');
    return await languageFor('coach', session);
  } catch (_) {
    return 'en';   // the refusal must never depend on a language lookup
  }
}

/**
 * Tell the coach, IN THE CHAT, why the form will not submit. An endpoint
 * error is not rendered by Meta — the coach sees only a generic "Something
 * went wrong" — so without this they never learn the observation is over.
 *
 * The recipient is the observation's owner (already checked against the
 * token), never a message sender. Total by construction: every failure is
 * logged and swallowed, because the refusal must never depend on delivery.
 *
 * @returns {Promise<boolean>} true when the coach was told, this time
 */
async function tellCoachRefused(userId, sessionId, message) {
  try {
    const claimed = await redisService.setNX(refusalNoticeKey(sessionId), '1', REFUSAL_NOTICE_TTL_S);
    if (!claimed) return false;
    const { data: who } = await supabase
      .from('users')
      .select('phone_number')
      .eq('id', userId)
      .maybeSingle();
    if (!who || !who.phone_number) {
      logToFile('⚠️ observe-form: no identity for the refused coach — nothing delivered', { sessionId, userId });
      return false;
    }
    // Lazy: the channel graph reaches back into routes; a top-level require closes a cycle.
    const WhatsAppService = require('../services/whatsapp.service');
    await WhatsAppService.sendMessage(who.phone_number, message);
    return true;
  } catch (err) {
    logToFile('⚠️ observe-form: could not deliver the refusal to the chat', { sessionId, error: err.message });
    return false;
  }
}

/** The coach-facing reason a closed form will not open or submit. */
function refusalMessage(lang, refusal) {
  return t(lang, refusal === 'terminal' ? 'flow_terminal_refused' : 'flow_already_finished');
}

async function loadSessionFromToken(flowToken, action) {
  const [userId, sessionId] = String(flowToken || '').split(':');
  if (!userId || !sessionId) return { error: 'Invalid flow token' };
  const { data: session, error } = await supabase
    .from('coaching_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  if (error || !session) return { error: 'Observation not found' };
  if (session.observation_type !== 'leader_observation') return { error: 'Not an observation' };
  const owner = session.observer_user_id || session.user_id;
  if (owner !== userId) {
    logToFile('🚫 observe-form: token does not own this observation', { sessionId, action });
    return { error: 'Not your observation' };
  }
  // A cancelled observation is not editable. The Flow is still sitting in the
  // coach's chat after a cancel; without this a stale form would submit,
  // promote the row, and start the report chain the coach cancelled.
  // Nor is one whose ratings are already saved: the same stale form would
  // re-score ratings the teacher may already hold and flip a completed
  // observation back to observer_review_complete.
  const refusal = isTerminalStatus(session.status) ? 'terminal'
    : (session.status !== ObserveEdits.IN_REVIEW_STATUS ? 'not_in_review' : null);
  if (refusal) {
    const message = refusalMessage(await coachLanguage(session), refusal);
    const notified = await tellCoachRefused(userId, sessionId, message);
    // Logged on EVERY refusal (the notice is send-once, the count is not).
    logToFile('🚫 observe-form: endpoint refused — the form is closed', {
      sessionId, status: session.status, refusal, action, notified,
    });
    return { error: message };
  }
  return { session, sessionId, userId };
}

async function bufferEdits(sessionId, screenData) {
  const edits = {};
  Object.entries(screenData || {}).forEach(([k, v]) => {
    if (/^(r|ev|imp)_/.test(k)) edits[k] = v;
  });
  let existing = {};
  try {
    // get() auto-parses JSON (object), falling back to the raw string.
    const raw = await redisService.get(editsKey(sessionId));
    if (raw) existing = typeof raw === 'object' ? raw : JSON.parse(raw);
  } catch (_) { /* corrupt buffer → start fresh */ }
  const merged = { ...existing, ...edits };
  await redisService.setexWithCeiling(editsKey(sessionId), EDITS_TTL, JSON.stringify(merged));
  return merged;
}

/**
 * @param {object} decrypted decrypted Flow request { action, flow_token, screen, data }
 * @returns {Promise<object>} Flow response ({ screen, data } | { data: { error } }) — never with `version`
 */
async function handleObserveFormRequest(decrypted) {
  const { action, flow_token: flowToken, data = {}, screen } = decrypted || {};
  try {
    if (action === 'ping') return { data: { status: 'active' } };

    const loaded = await loadSessionFromToken(flowToken, action);
    if (loaded.error) return errorResponse(loaded.error);
    const { session, sessionId } = loaded;
    const s = screens();

    if (action === 'INIT' || action === 'init') return screenResponse(session, s.first);

    if (action === 'BACK') return screenResponse(session, s.ids.includes(screen) ? screen : s.first);

    if (action === 'data_exchange') {
      const current = (data && data._screen) || screen;
      if (!s.ids.includes(current)) return errorResponse('Unknown screen');
      const merged = await bufferEdits(sessionId, data);

      if (current !== s.last) return screenResponse(session, s.next(current));

      const applied = await ObserveEdits.applyObserverEdits(sessionId, merged);
      if (applied && applied.refused) {
        // Cancelled, or saved by the other surface, between the load above and
        // the write. Never reach SUCCESS: its completion is what starts the
        // debrief and report chain.
        return errorResponse(refusalMessage(await coachLanguage(session), applied.refused));
      }
      await redisService.delete(editsKey(sessionId));
      return {
        screen: 'SUCCESS',
        data: {
          session_id: sessionId,
          extension_message_response: {
            params: { observe_action: 'submitted', session_id: sessionId, flow_token: flowToken },
          },
        },
      };
    }

    return errorResponse('Unsupported action');
  } catch (err) {
    logToFile('❌ observe-form endpoint error', { error: err.message, action });
    return errorResponse('Something went wrong — please try again.');
  }
}

module.exports = { handleObserveFormRequest };
