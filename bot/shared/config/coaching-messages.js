/**
 * Coaching System Messages — i18n catalog
 *
 * Centralises every system message the coaching pipeline sends to teachers
 * over WhatsApp, so translations can be added per-locale without hunting
 * across the pipeline's service files. The same multi-language shape used
 * elsewhere in the bot (`config/system-messages.js` and `config/branding.js`)
 * applies: ten supported language codes, English-fallback when a locale's
 * translation is absent.
 *
 * Supported language codes (canonical):
 *   en, ur, ar, es, sw, 'bal-PK', 'sd-PK', 'ps-PK', 'pa-PK', 'ta-LK'
 *
 * Adding a translation:
 *   1. Find the message key below
 *   2. Replace the `// TODO: translate to <lang>` placeholder with the
 *      localised string. Keep the SAME emoji placement and `${var}`
 *      template positions.
 *   3. Run `node tests/run.js tests/setup/coaching-i18n-catalog.test.js`
 *      — the ratchet asserts every message has all 10 language keys.
 *
 * Adding a new message:
 *   1. Add a new key here with the full 10-language object (the others
 *      can start as English placeholders carrying the same TODO marker).
 *   2. Call `getCoachingMessage('<your.key>', languageCode)` at the
 *      emit site. The ratchet test below catches any
 *      `WhatsAppService.sendMessage(..., '<English literal>')` in
 *      `bot/shared/services/coaching/` so this catalog stays the
 *      single source of truth.
 *
 * Why placeholders are English (not empty):
 *   We never want a missing translation to silently send a blank
 *   message. Falling back to English keeps the feature working until
 *   the translation lands.
 */

const SUPPORTED_LANGUAGES = ['en', 'ur', 'ar', 'es', 'sw', 'bal-PK', 'sd-PK', 'ps-PK', 'pa-PK', 'ta-LK'];

// Sentinel — every non-`en` value below starts here as a placeholder.
// Translations replace these in-place; the helper falls back to `en`
// for any value that still equals the sentinel string.
const TODO = '__TODO_TRANSLATE__';

function en(text) {
  return Object.fromEntries(SUPPORTED_LANGUAGES.map((code) => [code, code === 'en' ? text : TODO]));
}

const COACHING_MESSAGES = {
  // Lesson-plan branch: teacher said NO lesson plan
  lessonPlan_skip: en("No problem! I'll analyze your classroom audio without the lesson plan."),
  // Lesson-plan branch: teacher said yes but didn't send the document
  lessonPlan_request: en("Great! Please send your lesson plan as a document (PDF, Word, or image).\n\nTap 📎 → Document to upload it."),
  // Lesson-plan branch: document received, queued for processing
  lessonPlan_received: en("📄 Lesson plan received! I'm processing it in the background and will weave it into your analysis."),
  // Lesson-plan branch: legacy ack
  lessonPlan_included: en("✅ Lesson plan received! I'll include this in my analysis."),
  // Recovery: teacher exited the coaching flow without sending audio
  exitedNoAudio: en("No problem! If you'd like to analyze classroom audio in the future, just send me a recording."),
  // Step 1/5 — transcription kickoff
  step1_transcribing: en("🔄 Step 1/5: Transcribing your classroom audio. This may take 30-60 seconds...hang in there!"),
  // Step 2/5 — pedagogy analysis kickoff (templated; `${step}` resolved by caller via interpolation OR by passing the number 2 when constant)
  step2_analyzing: en("🔄 Step 2/5: Analyzing your teaching using research-based pedagogical frameworks..."),
  // Step 3/5 — reflective conversation kickoff
  step3_reflecting: en("🔄 Step 3/5: Let's reflect on your teaching together..."),
  // Step 4/5 — report generation kickoff
  step4_generatingReport: en("🔄 Step 4/5: Generating your comprehensive observation report with visualizations..."),
  // Step 5/5 — voice debrief generation kickoff
  step5_voiceDebrief: en("🔄 Step 5/5: Creating your personalized voice debrief..."),
  // Final report delivery
  reportReady: en("✅ Your Classroom Observation Report is ready! 📄"),
  // Voice summary delivery prefix
  voiceSummaryReady: en("🎤 Here's your personalized voice summary:"),
  // Reflective conversation graceful close
  reflectionsThanks: en("Thank you for your thoughtful reflections! 🙏"),
  // Retry path: analysis still running when report is requested
  reportInProgress: en("🔄 I'm still processing your classroom analysis. I'll share your report as soon as it's ready."),
  // Voice debrief fallback when generation fails post-PDF
  voiceSummaryFallback: en("Note: Voice summary could not be generated, but your written report is complete! You can review it in the PDF above. 📄"),
  // Long transcript warning (transcription pipeline)
  longLessonDetected: en("⚠️ *Long Lesson Detected*\n\nYour lesson transcript is quite lengthy. The analysis may take a bit longer, but I'll make sure to provide comprehensive feedback!"),
  // Agency follow-up: remind the teacher of their prior commitment.
  // {{action}} is substituted at the call site (kept distinct from
  // ${} JS interpolation so this string can be translated 1:1).
  priorActionReminder: en('💡 *Quick reminder:* Last time, you committed to:\n\n_"{{action}}"_\n\nLet\'s see how it went in this session!'),

  // Classroom-photo question: the teacher tapped "Yes" or "Add another"
  photo_sendNow: en("📸 Send your classroom photo now."),

  // ── Lesson-plan fidelity (LP_FIDELITY_ENABLED) ──────────────────────
  // The lesson-plan step after a recording, when fidelity is on: a plan can
  // also be pasted as text.
  lessonPlan_request_or_paste: en("Great! Send your lesson plan as a document (PDF or Word), or paste its text here as one message."),
  lessonPlan_linked: en("✅ Got it — I'll compare your lesson with that plan."),
  lessonPlan_pasted: en("📄 Thanks — I've got your lesson plan. I'll compare your lesson with it."),
  // One line per fidelity outcome, sent after the report and printed in it.
  // Each state has its OWN words: the teacher should never have to guess
  // whether the plan, the recording or our system was the problem.
  // {{delivered}}, {{total}} and {{band}} are filled at the call site.
  fidelity_measured: en("📋 *Did the lesson follow the plan?* {{delivered}} of {{total}} planned moves were seen in your recording — {{band}}. Your report lists each move with the moment it happened."),
  fidelity_lesson_mismatch: en("📋 *Did the lesson follow the plan?* This recording doesn't seem to match the lesson plan you linked, so the planned moves weren't seen. If you taught a different lesson, link that lesson's plan next time."),
  fidelity_no_timings: en("📋 Your lesson wasn't compared with your plan this time: the recording came back without speech timings, so moves couldn't be matched to moments. That's a recording problem, not a teaching one."),
  fidelity_recording_unusable: en("📋 Your lesson wasn't compared with your plan this time: the recording was too unclear to judge the planned moves. That's a recording problem, not a teaching one."),
  fidelity_no_plan: en("📋 No lesson plan was linked, so this lesson wasn't compared with a plan. Next time, pick or send the plan you meant to teach."),
  fidelity_plan_unreadable: en("📋 I couldn't read your lesson plan, so this lesson wasn't compared with it. Next time, send it as a Word file or paste the text (photos and scanned pages can't be read yet)."),
  fidelity_grader_failed: en("📋 The lesson-plan check couldn't run this time because of a problem on our side. The rest of your report is complete."),
  fidelity_band_high: en("you followed your plan closely"),
  fidelity_band_partial: en("you followed part of your plan"),
  fidelity_band_low: en("most of your plan wasn't seen"),
};

/**
 * Return the localised message for `key` in `languageCode`. Falls back
 * to English if the key isn't translated for that language (the
 * placeholder sentinel) or the language isn't supported.
 *
 * @param {string} key — one of the keys in COACHING_MESSAGES
 * @param {string} languageCode — e.g. 'en', 'ur', 'sw'
 * @returns {string}
 */
function getCoachingMessage(key, languageCode = 'en') {
  const entry = COACHING_MESSAGES[key];
  if (!entry) {
    throw new Error(`Unknown coaching message key: ${key}`);
  }
  const candidate = entry[languageCode];
  if (candidate && candidate !== TODO) return candidate;
  return entry.en;
}

module.exports = {
  COACHING_MESSAGES,
  SUPPORTED_LANGUAGES,
  TODO,
  getCoachingMessage,
};
