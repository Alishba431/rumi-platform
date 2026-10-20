'use strict';
/**
 * Fidelity pre-flight: deterministic facts about the RECORDING — how many [MM:SS] stamps it carries, where the
 * transcript ends against the audio, whether it collapsed into one timestamped block. Pure: no I/O, no LLM.
 *
 * `no_timestamps` is the input contract the orchestrator enforces before any model call: every verdict above
 * not_done must quote a stamped span, so a transcript without stamps cannot be judged move by move. The rest is
 * telemetry persisted on every graded blob (lp_fidelity.recording). It is NOT a truncation detector: a transcript
 * that stops well before the audio is quiet independent work as often as lost speech, so nothing here changes a
 * verdict.
 *
 * STAMP_RE is the one definition of a transcript timestamp. audio.service writes `[MM:SS]` per speaker turn; minutes
 * may run past 99 on a long recording, so 1-3 digits.
 */
const STAMP_SOURCE = '\\[(\\d{1,3}):(\\d{2})\\]';
const STAMP_RE = new RegExp(STAMP_SOURCE);
const TAIL_GRACE_S = 90;
const COLLAPSE_SHARE = 0.4;

function mmss(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** True when the transcript carries at least one [MM:SS] stamp. */
function hasTimestamps(transcript) {
  return STAMP_RE.test(String(transcript || ''));
}

/**
 * @param {string} transcript             the timestamped transcript
 * @param {number|null} audioDurationSeconds coaching_sessions.audio_duration_seconds
 * @returns {{stamps:number, no_timestamps:boolean, last_stamp_s:number|null, ends_at:string|null, audio_s:number|null,
 *            transcript_short_of_audio:boolean, collapsed_block:boolean}}
 */
function describeRecording(transcript, audioDurationSeconds) {
  const t = String(transcript || '');
  const re = new RegExp(STAMP_SOURCE, 'g');
  const stamps = [];
  let m;
  while ((m = re.exec(t)) !== null) stamps.push({ s: Number(m[1]) * 60 + Number(m[2]), i: m.index });
  const lastStampS = stamps.length ? stamps[stamps.length - 1].s : null;
  const n = Number(audioDurationSeconds);
  const audioS = audioDurationSeconds != null && Number.isFinite(n) && n > 0 ? n : null;
  let biggest = 0;
  for (let k = 0; k < stamps.length; k += 1) {
    const end = k + 1 < stamps.length ? stamps[k + 1].i : t.length;
    biggest = Math.max(biggest, end - stamps[k].i);
  }
  return {
    stamps: stamps.length,
    no_timestamps: stamps.length === 0,
    last_stamp_s: lastStampS,
    ends_at: lastStampS == null ? null : mmss(lastStampS),
    audio_s: audioS,
    transcript_short_of_audio: lastStampS != null && audioS != null && audioS - lastStampS > TAIL_GRACE_S,
    collapsed_block: stamps.length > 0 && t.length > 0 && biggest / t.length >= COLLAPSE_SHARE,
  };
}

module.exports = { describeRecording, hasTimestamps, STAMP_RE };
