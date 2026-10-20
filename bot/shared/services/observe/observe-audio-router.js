/**
 * The ONE place that decides what a coach's audio means.
 *
 * WHY THIS EXISTS: audio reaches the bot through two entry points —
 *   1. a voice note / audio message → voice-message.handler
 *   2. an audio FILE (document)     → the document branch in whatsapp-bot.js
 * A phone recorder app delivers a 40-minute lesson as a FILE, so path 2 is the
 * NORMAL way a coach sends a classroom recording. Intercepting only path 1
 * lets file-sent recordings sail past /observe into the TEACHER coaching flow.
 *
 * The duration is resolved HERE, not trusted from the caller: inbound webhooks
 * rarely carry one (Meta never does for voice notes; Matrix sends file size
 * only), so a caller-computed "is it long?" is almost always false. The router
 * asks the channel for the media info, and probes the bytes with ffprobe when
 * only a large file size is known.
 *
 * Invariant: a coach's classroom-length audio NEVER starts a teacher coaching
 * session — not on a lost state, not on a Redis blip, not on a capture
 * failure, not on an unresolvable duration with a large file.
 */

const WhatsAppService = require('../whatsapp.service');
const ObserveState = require('./observe-state.service');
const { t, observeLang } = require('./observe-strings');
const { isObserveEnabled, isSchoolLeader, canSelfCoach } = require('./observe-gate');
const { logToFile } = require('../../utils/logger');

// The same classroom line the self-coaching path draws (COACHING_MIN_AUDIO_SECONDS,
// default 15 minutes), read at call time: anything that path would treat as a lesson
// must be an observation here, or a coach's recording would start their own coaching.
const { classroomAudioThresholdSeconds } = require('../../config/coaching-audio');
const LARGE_FILE_BYTES = 500_000;    // the self-coaching path's "suspiciously large" line
// A "send me your classroom recording" from the menu is an answer for a while,
// not forever — after that the recording is an observation again.
const DC_INTENT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Resolve the REAL duration: caller-supplied → channel media info → ffprobe.
 * Returns { dur, fileSize } — dur 0 when genuinely unresolvable.
 */
async function _resolveDuration(audioId, durationSeconds) {
  let dur = Number(durationSeconds) || 0;
  let fileSize = 0;
  if (dur) return { dur, fileSize };
  try {
    const meta = await WhatsAppService.getMediaInfo(audioId);
    dur = Math.round(meta?.audio?.duration || meta?.voice?.duration || meta?.duration || 0);
    fileSize = meta?.file_size || 0;
    if (!dur && fileSize >= LARGE_FILE_BYTES) {
      const buf = await WhatsAppService.downloadMedia(audioId);
      const AudioService = require('../audio.service');
      dur = Math.round(await AudioService.getAudioDuration(buf));
    }
  } catch (err) {
    logToFile('⚠️ observe: duration probe failed for leader audio', { audioId, error: err.message });
  }
  return { dur, fileSize };
}

/**
 * Did this user just ask for THEIR OWN lesson to be coached? The menu's
 * "Classroom Coaching" choice writes AWAITING_CLASSROOM_AUDIO onto the chat
 * session. Pure; a malformed or expired state is simply NOT intent.
 */
function hasDeclaredDcIntent(conversationState) {
  const cs = conversationState;
  if (!cs || typeof cs !== 'object' || Array.isArray(cs)) return false;
  if (cs.current_state !== 'AWAITING_CLASSROOM_AUDIO') return false;
  const since = Date.parse(cs.awaiting_audio_since || '');
  if (Number.isNaN(since)) return false;
  return Date.now() - since < DC_INTENT_TTL_MS;
}

async function _chatConversationState(sessionId) {
  if (!sessionId) return null;
  try {
    const supabase = require('../../config/supabase');
    const { data } = await supabase.from('chat_sessions').select('conversation_state').eq('id', sessionId).maybeSingle();
    return (data && data.conversation_state) || null;
  } catch (_) {
    return null;
  }
}

/**
 * A classroom-length recording nobody armed for: park it and ask the coach
 * whose it is (observe-binding). Handled either way — never self-coaching. If
 * the park itself fails (Redis down), fall back to telling the coach to start
 * from /observe: the recording is never silently lost into another feature.
 */
async function _unbound(user, from, media) {
  try {
    const Binding = require('./observe-binding.service');
    await Binding.parkAndAsk(user, from, media);
    return;
  } catch (err) {
    logToFile('⚠️ observe: park failed — telling the coach to start from /observe', { userId: user.id, error: err.message });
  }
  await WhatsAppService.sendMessage(from, t(observeLang(user), 'long_audio_no_state'));
}

/**
 * @param {object}  opts.user         users row (may be null)
 * @param {string}  opts.from         sender channel identity
 * @param {string}  opts.audioId      media id (voice note id OR document id)
 * @param {string}  opts.sessionId    chat session id
 * @param {boolean} opts.isLongAudio  caller already probed it long — trusted when true
 * @param {number}  opts.durationSeconds  caller-resolved duration, if any
 * @param {string}  opts.mimeType     inbound MIME, kept with a debrief so the worker
 *                                    knows the real container
 * @returns {Promise<boolean>} handled? (true → caller returns immediately)
 */
async function routeLeaderAudio({
  user, from, audioId, sessionId, isLongAudio = false, durationSeconds = null, sha256 = null, mimeType = null,
}) {
  if (!isObserveEnabled()) return false;
  if (!isSchoolLeader(user)) return false;   // teachers untouched

  const lang = observeLang(user);
  const { dur, fileSize } = await _resolveDuration(audioId, durationSeconds);
  // Classroom-recording test: resolved-long, OR unresolvable-but-large, OR the
  // caller already probed it long. A resolved-short small file is the coach
  // TALKING to Rumi — that stays chat.
  const looksLikeClassroom = dur >= classroomAudioThresholdSeconds()
    || (!dur && fileSize >= LARGE_FILE_BYTES)
    || isLongAudio;
  const media = { audioId, sha256, durationSeconds: dur || null, mimeType, sessionId };

  let state = null;
  try {
    state = await ObserveState.getState(user.id);
  } catch (err) {
    logToFile('⚠️ observe: state lookup failed for leader audio', { userId: user.id, error: err.message });
    // Fail SAFE: a state error must never open the teacher-coaching door.
    if (looksLikeClassroom) { await _unbound(user, from, media); return true; }
    return false;
  }

  try {
    if (state && state.state === 'awaiting_audio') {
      const ObserveCapture = require('./observe-capture.service');
      // Pass the resolved duration through — dropping it stores NULL
      // ("your 0-minute recording").
      const session = await ObserveCapture.startFromAudio(user, from, audioId, sessionId, dur || null);
      // Remember it, so an identical re-send is answered "already got this one".
      if (session) {
        try {
          await require('./observe-binding.service').rememberCaptured(user.id, media, session,
            (state.boundTeacher && state.boundTeacher.name) || null);
        } catch (_) { /* best-effort */ }
      }
      logToFile('🔭 observe: classroom recording captured', { userId: user.id, audioId });
      return true;
    }
    if (state && state.state === 'awaiting_debrief_audio') {
      // The coach was handed a debrief guide and asked to record the
      // conversation: any length is that recording (a too-short one is caught
      // by the worker, which re-arms and asks again).
      const ObserveDebrief = require('./observe-debrief.service');
      await ObserveDebrief.startDebriefFromAudio(user, from, audioId, state, { mimeType });
      logToFile('🔭 observe: debrief recording received', { userId: user.id, audioId, sessionId: state.sessionId });
      return true;
    }
  } catch (err) {
    logToFile('❌ observe: leader audio capture failed', { userId: user.id, state: state && state.state, error: err.message });
    await WhatsAppService.sendMessage(from, t(lang, 'debrief_load_error'));
    return true;   // never fall through into teacher coaching on an error
  }

  if (!looksLikeClassroom) return false;   // the coach is talking to Rumi

  // Nothing armed. Before treating this as an observation, honour what they
  // ASKED for: a principal who picked "Classroom Coaching" from the menu and
  // was told to send their own recording gets self-coaching. Full-time coaches
  // fail canSelfCoach, so the invariant holds for them unconditionally.
  if (canSelfCoach(user) && hasDeclaredDcIntent(await _chatConversationState(sessionId))) {
    logToFile('🎓 observe: leader declared their own coaching — falling through', { userId: user.id, audioId, dur });
    return false;
  }

  logToFile('🔭 observe: unbound leader recording', { userId: user.id, audioId, dur, slotState: state && state.state });
  await _unbound(user, from, media);
  return true;   // the invariant: never teacher coaching for a coach's classroom audio
}

module.exports = { routeLeaderAudio, hasDeclaredDcIntent, LARGE_FILE_BYTES };
