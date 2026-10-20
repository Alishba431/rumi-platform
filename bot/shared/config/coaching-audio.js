/**
 * When is a recording a classroom lesson?
 *
 * Audio at least COACHING_MIN_AUDIO_SECONDS long (default 900, 15 minutes) starts the coaching flow; anything
 * shorter is a voice note. One setting, read by both entry points (a voice message, and audio sent as a document).
 * Values under a minute are refused: a voice note must never start a coaching session.
 */
const DEFAULT_SECONDS = 900;
const MIN_SECONDS = 60;

function classroomAudioThresholdSeconds() {
  const n = Math.floor(Number(process.env.COACHING_MIN_AUDIO_SECONDS));
  return Number.isFinite(n) && n >= MIN_SECONDS ? n : DEFAULT_SECONDS;
}

/**
 * The recording's length in seconds. Meta reports it with the media; Matrix, Slack and Discord do not, and a missing
 * duration read as 0 meant a lesson recording on those channels could never start coaching. Then the audio is
 * downloaded once and measured, and the buffer handed back so the caller does not download it again.
 * Never throws: a recording that cannot be measured is 0 seconds (treated as a voice note).
 * @returns {Promise<{seconds:number, buffer:Buffer|null}>}
 */
async function resolveAudioDurationSeconds(mediaId, metadata, deps = {}) {
  const reported = Number((metadata && ((metadata.audio && metadata.audio.duration) || (metadata.voice && metadata.voice.duration))) || 0);
  if (reported > 0) return { seconds: reported, buffer: null };
  const download = deps.downloadMedia || ((id) => require('../services/whatsapp.service').downloadMedia(id));
  const measure = deps.measure || ((b) => require('../services/audio.service').getAudioDuration(b));
  let buffer = null;
  try {
    buffer = await download(mediaId);
    const seconds = Number(await measure(buffer)) || 0;
    return { seconds, buffer };
  } catch (_) {
    return { seconds: 0, buffer };
  }
}

module.exports = { classroomAudioThresholdSeconds, resolveAudioDurationSeconds, DEFAULT_SECONDS };
