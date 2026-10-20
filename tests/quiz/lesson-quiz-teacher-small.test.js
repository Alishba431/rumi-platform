'use strict';
/**
 * Small teacher-side fixes (review F-N8).
 *
 *   - "No" tapped after "Yes" while the quiz is being made said "declined",
 *     although the quiz was still coming.
 *   - feature-availability showed the lesson quiz as available with
 *     TRANSCRIPT_QUIZ_ENABLED=false (presence only), though the offer needs `true`.
 *   - the nudge read, then wrote: a redelivered job could send it twice.
 *   - RUMI_FEATURE_LESSON_QUIZ=off stopped new offers but not a nudge already
 *     queued.
 *
 * The real offer and nudge services on the schema-checked in-memory database;
 * the sends and the queue are mocked at their boundaries.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-digest.service', () => ({ run: jest.fn() }));
jest.mock('../../bot/shared/services/feature-intro.service', () => ({
  hasSeenIntroVideo: jest.fn().mockResolvedValue(false), markVideoShown: jest.fn(),
}));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-language', () => require('./helpers/language-mock').factory());
jest.mock('../../bot/shared/services/quiz/teacher-self-test', () => require('./helpers/language-mock').selfTestFactory());
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const { resolveUx } = require('../../bot/shared/config/ux-strings');
const { makeSchemaDb } = require('./helpers/schema-db');
const { FEATURES, isFeatureAvailable, overrides } = require('../../bot/shared/config/feature-availability');
const Offer = require('../../bot/shared/services/quiz/transcript-quiz-offer.service');
const Nudge = require('../../bot/shared/services/quiz/transcript-quiz-nudge.service');

const QID = '22222222-2222-4222-8222-222222222222';
const UID = '33333333-3333-4333-8333-333333333333';
const PHONE = '15550100001';

let db;
function install(quizzes, sessions = []) {
  db = makeSchemaDb({
    users: [{ id: UID, phone_number: PHONE, preferred_language: 'en' }],
    quizzes,
    quiz_sessions: sessions,
  });
  supabase.from.mockImplementation(db.from);
}

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, TRANSCRIPT_QUIZ_ENABLED: 'true', QUIZ_LANGUAGES: 'en', QUIET_HOURS: 'off' };
  delete process.env.RUMI_FEATURE_LESSON_QUIZ;
  overrides.load(process.env);
});
afterAll(() => { process.env = ENV; overrides.load(process.env); });

describe('"No" after "Yes"', () => {
  test('while the quiz is being made: "it is being made", never "declined"; the row is untouched', async () => {
    install([{ id: QID, teacher_id: UID, quiz_source: 'transcript', status: 'generating', meta: { step: 'author' } }]);
    await Offer.handleOfferButton(`tq_no_${QID}`, PHONE);
    const said = WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);
    expect(said).not.toContain(resolveUx('tqDeclined', { language: 'en' }));
    expect(said).toContain(resolveUx('tqAlreadyMaking', { language: 'en' }));
    expect(db.tables.quizzes[0].status).toBe('generating');
  });

  test('on an offer still open: declined, as before', async () => {
    install([{ id: QID, teacher_id: UID, quiz_source: 'transcript', status: 'offered', meta: { step: 'offered' } }]);
    await Offer.handleOfferButton(`tq_no_${QID}`, PHONE);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqDeclined', { language: 'en' }));
    expect(db.tables.quizzes[0].status).toBe('declined');
  });

  test('"No" twice: the second still says declined', async () => {
    install([{ id: QID, teacher_id: UID, quiz_source: 'transcript', status: 'declined', meta: { step: 'declined' } }]);
    await Offer.handleOfferButton(`tq_no_${QID}`, PHONE);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqDeclined', { language: 'en' }));
  });
});

describe('feature availability', () => {
  const entry = () => FEATURES.find((f) => f.id === 'lesson_quiz');
  test('TRANSCRIPT_QUIZ_ENABLED=false is not "available"', () => {
    expect(isFeatureAvailable(entry(), { TRANSCRIPT_QUIZ_ENABLED: 'false' }, { ignoreOverrides: true })).toBe(false);
  });
  test('TRANSCRIPT_QUIZ_ENABLED=true is', () => {
    expect(isFeatureAvailable(entry(), { TRANSCRIPT_QUIZ_ENABLED: 'true' }, { ignoreOverrides: true })).toBe(true);
  });
});

function sentQuiz() {
  return {
    id: QID, teacher_id: UID, quiz_source: 'transcript', topic: 'Fractions', status: 'sent',
    meta: { sent_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString() }, created_at: new Date().toISOString(),
  };
}

describe('the nudge claims before it sends', () => {
  test('two deliveries at once: ONE nudge', async () => {
    install([sentQuiz()]);
    await Promise.all([Nudge.process(QID), Nudge.process(QID)]);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.tables.quizzes[0].meta.nudged_at).toBeTruthy();
  });
});

describe('RUMI_FEATURE_LESSON_QUIZ=off', () => {
  test('a nudge already queued exits quietly: nothing read, nothing sent', async () => {
    install([sentQuiz()]);
    process.env.RUMI_FEATURE_LESSON_QUIZ = 'off';
    overrides.load(process.env);
    const r = await Nudge.process(QID);
    expect(r).toEqual({ skipped: 'paused' });
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
