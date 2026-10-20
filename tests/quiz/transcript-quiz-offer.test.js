'use strict';
/**
 * The offer after a coaching report. One quizzes row per coaching session, one
 * ask at a time, once per teacher, flag-gated, and the yes/no buttons flip
 * state exactly once however many times they are tapped.
 *
 * Open-source specifics: `coaching_sessions` has no `observation_type` (every
 * completed session is the teacher's own lesson), there is no intro film, and
 * the offer is plain buttons — which every channel driver renders (natively on
 * Meta, as numbered text on Baileys).
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-digest.service', () => ({ run: jest.fn() }));
jest.mock('../../bot/shared/services/feature-intro.service', () => ({
  hasSeenIntroVideo: jest.fn().mockResolvedValue(false),
  markVideoShown: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-language', () => require('./helpers/language-mock').factory());
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Queue = require('../../bot/shared/services/queue');
const Digest = require('../../bot/shared/services/quiz/transcript-quiz-digest.service');
const FeatureIntro = require('../../bot/shared/services/feature-intro.service');
const { logEvent } = require('../../bot/shared/utils/structured-logger');
const { logToFile } = require('../../bot/shared/utils/logger');
const { installFrom } = require('./helpers/supabase-chain');
const { makeSchemaDb } = require('./helpers/schema-db');
const Offer = require('../../bot/shared/services/quiz/transcript-quiz-offer.service');

const SID = '11111111-1111-4111-8111-111111111111';
const QID = '22222222-2222-4222-8222-222222222222';
const UID = '33333333-3333-4333-8333-333333333333';
const PHONE = '15550100001';

const SESSION = {
  id: SID, user_id: UID, status: 'completed',
  transcript_text: 'x'.repeat(3000), transcript_language: 'ur', created_at: '2026-09-05T05:00:00Z',
  analysis_data: { topic: 'Fractions', subject: 'Maths' },
  users: { id: UID, phone_number: PHONE, preferred_language: 'ur', name: 'Sample Teacher', grades_taught: ['4'] },
};
const GOOD_DIGEST = {
  digest: {
    topic: 'Fractions', topic_as_taught: 'کسریں', subject: 'maths', grade_band: '3-5',
    language_of_instruction: 'ur', confidence: 0.9,
    slos: [{ id: 'S1', statement: 'a', taught_level: 'recall' }, { id: 'S2', statement: 'b', taught_level: 'understand' }],
  },
  grade: '4', gradeSource: 'profile', lpHint: null, model: 'm', costUsd: 0.001,
};

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, TRANSCRIPT_QUIZ_ENABLED: 'true', QUIZ_LANGUAGES: 'en,ur' };
  delete process.env.TRANSCRIPT_QUIZ_OFFER_MODE;
  delete process.env.TRANSCRIPT_QUIZ_SUBJECTS;
  FeatureIntro.hasSeenIntroVideo.mockResolvedValue(false);
});
afterAll(() => { process.env = ENV; });

describe('scheduleOffer', () => {
  test('enqueues a quiz_offer 240 s later and reports scheduled', async () => {
    const ok = await Offer.scheduleOffer({
      coachingSessionId: SID, userId: UID, phone: PHONE, language: 'ur', transcriptChars: 3000,
    });
    expect(ok).toBe(true);
    expect(Queue.queueJob).toHaveBeenCalledWith(SID, 'quiz_offer', expect.objectContaining({ coachingSessionId: SID }),
      expect.objectContaining({ delaySeconds: 240 }));
  });

  test('a queue that refuses the job reports NOT scheduled (the report generator then sends its own follow-ups)', async () => {
    Queue.queueJob.mockRejectedValueOnce(new Error('queue down'));
    const ok = await Offer.scheduleOffer({
      coachingSessionId: SID, userId: UID, phone: PHONE, language: 'en', transcriptChars: 3000,
    });
    expect(ok).toBe(false);
  });

  test('does nothing when the flag is unset', async () => {
    delete process.env.TRANSCRIPT_QUIZ_ENABLED;
    expect(await Offer.scheduleOffer({ coachingSessionId: SID, userId: UID, phone: 'p', transcriptChars: 3000 })).toBe(false);
    expect(Queue.queueJob).not.toHaveBeenCalled();
  });

  test('skips a thin transcript and logs why', async () => {
    expect(await Offer.scheduleOffer({ coachingSessionId: SID, userId: UID, phone: 'p', transcriptChars: 900 })).toBe(false);
    expect(Queue.queueJob).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith('transcript_quiz.skipped', expect.objectContaining({ reason: 'transcript_too_short' }));
  });

  test('once mode: a teacher who has already been offered is not offered again', async () => {
    FeatureIntro.hasSeenIntroVideo.mockResolvedValue(true);
    expect(await Offer.scheduleOffer({ coachingSessionId: SID, userId: UID, phone: 'p', transcriptChars: 3000 })).toBe(false);
    expect(Queue.queueJob).not.toHaveBeenCalled();
  });

  test('every mode: offered again', async () => {
    process.env.TRANSCRIPT_QUIZ_OFFER_MODE = 'every';
    FeatureIntro.hasSeenIntroVideo.mockResolvedValue(true);
    expect(await Offer.scheduleOffer({ coachingSessionId: SID, userId: UID, phone: 'p', transcriptChars: 3000 })).toBe(true);
  });
});

describe('processOffer against the open-source schema', () => {
  // The read the offer makes is the first thing a clone runs. A column this
  // schema never had makes PostgREST refuse the whole read, and every offer
  // would then fail as "session not found" — silently, since the job succeeds.
  test('a finished lesson is offered a quiz: the session read names only columns coaching_sessions and users have', async () => {
    Digest.run.mockResolvedValue(GOOD_DIGEST);
    const db = makeSchemaDb({ coaching_sessions: [SESSION], quizzes: [] });
    supabase.from.mockImplementation(db.from);

    const r = await Offer.processOffer(SID, {});

    expect(db.refused).toEqual([]);
    const notFound = logToFile.mock.calls.find((c) => /session not found for offer/.test(c[0]));
    expect(notFound ? notFound[1] : null).toBeNull();
    expect(r).toEqual(expect.objectContaining({ ok: true }));
    expect(Digest.run).toHaveBeenCalledTimes(1);
    expect(db.tables.quizzes).toHaveLength(1);
    expect(db.tables.quizzes[0]).toEqual(expect.objectContaining({
      quiz_source: 'transcript', coaching_session_id: SID, status: 'offered',
    }));
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledTimes(1);
  });

  test('the second offer job for the same session is a no-op (the unique index answers 23505)', async () => {
    Digest.run.mockResolvedValue(GOOD_DIGEST);
    process.env.TRANSCRIPT_QUIZ_OFFER_MODE = 'every';
    const db = makeSchemaDb({ coaching_sessions: [SESSION], quizzes: [] });
    supabase.from.mockImplementation(db.from);
    await Offer.processOffer(SID, {});
    const second = await Offer.processOffer(SID, { early: true });
    expect(second.skipped).toBe('already_claimed');
    expect(db.tables.quizzes).toHaveLength(1);
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledTimes(1);
  });

  test('the offer service does not ask for observation_type anywhere', () => {
    expect(Offer.SESSION_SELECT).not.toMatch(/observation_type/);
  });
});

describe('processOffer (worker)', () => {
  test('claims the row, digests, stores offered, sends plain buttons, marks the teacher offered', async () => {
    Digest.run.mockResolvedValue(GOOD_DIGEST);
    installFrom(supabase.from, ({
      coaching_sessions: { data: [SESSION] },
      quizzes: { data: [{ id: QID }] },
    }));
    const r = await Offer.processOffer(SID, {});
    expect(r.ok).toBe(true);
    const inserts = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'insert');
    expect(inserts[0][1]).toEqual(expect.objectContaining({
      quiz_source: 'transcript', coaching_session_id: SID, teacher_id: UID, status: 'generating',
    }));
    const updates = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update');
    const offered = updates.find((u) => u[1].status === 'offered');
    expect(offered[1].language).toBe('ur');
    expect(offered[1].meta.grade).toBe('4');
    expect(offered[1].meta.digest.slos).toHaveLength(2);
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledTimes(1);
    const [to, { body, buttons }] = WhatsAppService.sendInteractiveButtons.mock.calls[0];
    expect(to).toBe(PHONE);
    expect(body).toMatch(/کسریں/);
    expect(buttons.map((b) => b.id)).toEqual([`tq_yes_${QID}`, `tq_no_${QID}`]);
    expect(FeatureIntro.markVideoShown).toHaveBeenCalledWith(UID, 'transcript_quiz');
  });

  test('the quiz language follows QUIZ_LANGUAGES: an English-only deployment writes an English quiz', async () => {
    process.env.QUIZ_LANGUAGES = 'en';
    Digest.run.mockResolvedValue(GOOD_DIGEST);
    installFrom(supabase.from, ({ coaching_sessions: { data: [SESSION] }, quizzes: { data: [{ id: QID }] } }));
    await Offer.processOffer(SID, {});
    const offered = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update').find((u) => u[1].status === 'offered');
    expect(offered[1].language).toBe('en');
  });

  test('is a no-op when another job already claimed the session (unique index 23505)', async () => {
    installFrom(supabase.from, ({
      coaching_sessions: { data: [SESSION] },
      quizzes: { data: null, error: { code: '23505', message: 'dup' } },
    }));
    const r = await Offer.processOffer(SID, {});
    expect(r.skipped).toBe('already_claimed');
    expect(Digest.run).not.toHaveBeenCalled();
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  test('a low-confidence digest marks the row skipped and sends nothing', async () => {
    Digest.run.mockResolvedValue({ ...GOOD_DIGEST, digest: { ...GOOD_DIGEST.digest, confidence: 0.3 } });
    installFrom(supabase.from, ({ coaching_sessions: { data: [SESSION] }, quizzes: { data: [{ id: QID }] } }));
    const r = await Offer.processOffer(SID, {});
    expect(r.skipped).toBe('low_confidence');
    const updates = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update');
    expect(updates.some((u) => u[1].status === 'skipped')).toBe(true);
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  test('a digest that throws marks the row skipped with the reason, and the teacher hears nothing', async () => {
    Digest.run.mockRejectedValue(new Error('provider refused'));
    installFrom(supabase.from, ({ coaching_sessions: { data: [SESSION] }, quizzes: { data: [{ id: QID }] } }));
    const r = await Offer.processOffer(SID, {});
    expect(r.skipped).toBe('model_failed');
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
  });

  test('a subject outside the allowlist is skipped', async () => {
    process.env.TRANSCRIPT_QUIZ_SUBJECTS = 'maths,science';
    Digest.run.mockResolvedValue({ ...GOOD_DIGEST, digest: { ...GOOD_DIGEST.digest, subject: 'history' } });
    installFrom(supabase.from, ({ coaching_sessions: { data: [SESSION] }, quizzes: { data: [{ id: QID }] } }));
    const r = await Offer.processOffer(SID, {});
    expect(r.skipped).toBe('subject_not_allowed');
  });

  test('a session that is not completed is skipped', async () => {
    installFrom(supabase.from, ({ coaching_sessions: { data: [{ ...SESSION, status: 'analyzing' }] } }));
    const r = await Offer.processOffer(SID, {});
    expect(r.skipped).toBe('status_analyzing');
  });

  test('an offer WhatsApp refused is still recorded as offered (the row) and logged undelivered', async () => {
    Digest.run.mockResolvedValue(GOOD_DIGEST);
    WhatsAppService.sendInteractiveButtons.mockResolvedValueOnce(false);
    installFrom(supabase.from, ({ coaching_sessions: { data: [SESSION] }, quizzes: { data: [{ id: QID }] } }));
    const r = await Offer.processOffer(SID, {});
    expect(r.ok).toBe(true);
    expect(logEvent).toHaveBeenCalledWith('transcript_quiz.offered', expect.objectContaining({ sent: false }));
  });
});

describe('handleOfferButton', () => {
  const TEACHER = { data: [{ id: UID, phone_number: PHONE, preferred_language: 'ur' }] };

  test('tq_yes with no language to ask flips offered→generating exactly once and enqueues quiz_generate', async () => {
    process.env.QUIZ_LANGUAGES = 'en';
    let flips = 0;
    installFrom(supabase.from, ({
      quizzes: (calls) => {
        if (calls.some((c) => c[0] === 'update')) {
          flips += 1;
          return flips === 1 ? { data: [{ id: QID }] } : { data: [] };   // second tap: no row matched
        }
        return { data: [{ id: QID, teacher_id: UID, status: 'offered', language: 'en', subject: 'maths', topic: 'Fractions' }] };
      },
      users: TEACHER,
    }));
    expect(await Offer.handleOfferButton(`tq_yes_${QID}`, PHONE)).toBe(true);
    expect(await Offer.handleOfferButton(`tq_yes_${QID}`, PHONE)).toBe(true);
    expect(Queue.queueJob).toHaveBeenCalledTimes(1);
    expect(Queue.queueJob).toHaveBeenCalledWith(QID, 'quiz_generate', expect.any(Object), expect.any(Object));
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(2);   // "making it" then "already on it"
  });

  test('tq_no marks declined and sends the decline copy in the teacher language', async () => {
    installFrom(supabase.from, ({
      quizzes: (calls) => (calls.some((c) => c[0] === 'update') ? { data: [{ id: QID }] }
        : { data: [{ id: QID, teacher_id: UID, status: 'offered', language: 'ur' }] }),
      users: TEACHER,
    }));
    expect(await Offer.handleOfferButton(`tq_no_${QID}`, PHONE)).toBe(true);
    const updates = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update');
    expect(updates[0][1].status).toBe('declined');
    expect(WhatsAppService.sendMessage.mock.calls[0][1]).toMatch(/\/quiz/);
    expect(WhatsAppService.sendMessage.mock.calls[0][1]).toMatch(/[؀-ۿ]/);
    expect(Queue.queueJob).not.toHaveBeenCalled();
  });

  test('a tap on an offer whose row is gone says the offer expired', async () => {
    installFrom(supabase.from, ({ quizzes: { data: [] }, users: { data: [{ preferred_language: 'en' }] } }));
    expect(await Offer.handleOfferButton(`tq_yes_${QID}`, PHONE)).toBe(true);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    expect(Queue.queueJob).not.toHaveBeenCalled();
  });

  test('ignores buttons that are not ours', async () => {
    expect(await Offer.handleOfferButton('vq_offer_yes', 'p')).toBe(false);
    expect(await Offer.handleOfferButton('quiz_yes_send_x', 'p')).toBe(false);
  });
});

describe('no intro film in the open-source offer', () => {
  test('the intro-video helpers are gone', () => {
    expect(Offer.introVideo).toBeUndefined();
    expect(Offer.introVideoShows).toBeUndefined();
  });
});

describe('the operator switch (RUMI_FEATURE_LESSON_QUIZ)', () => {
  const { FEATURES, overrides } = require('../../bot/shared/config/feature-availability');
  afterEach(() => { delete process.env.RUMI_FEATURE_LESSON_QUIZ; overrides.load(process.env); });

  test('the lesson quiz is a registered feature, switched on by TRANSCRIPT_QUIZ_ENABLED', () => {
    const entry = FEATURES.find((f) => f.id === 'lesson_quiz');
    expect(entry).toBeDefined();
    expect(entry.keys).toEqual(['TRANSCRIPT_QUIZ_ENABLED']);
  });

  test('switching the feature off in the console turns the offer and the menu off, keeping the flag', () => {
    process.env.TRANSCRIPT_QUIZ_ENABLED = 'true';
    expect(Offer.enabled()).toBe(true);
    process.env.RUMI_FEATURE_LESSON_QUIZ = 'off';
    overrides.load(process.env);
    expect(Offer.enabled()).toBe(false);
  });
});
