'use strict';
/**
 * The coaching report's own follow-ups when the lesson-quiz offer never goes
 * out (review F-S4).
 *
 * The report holds back Trigger 3 (a quiz to the parents' phones) and the
 * next-feature suggestion while the lesson-quiz offer is on its way. The offer
 * job can still decide not to offer (low confidence, too few objectives, a
 * subject filter, a failed digest) — and then the teacher got neither. The job
 * now runs the held-back follow-ups itself, once. And an offer whose send
 * failed no longer counts as "this teacher has had the offer".
 *
 * The real worker (its quiz_offer case), the real offer service and the real
 * report generator (Trigger 3 included) run; the database is the
 * schema-checked in-memory one, the sends, the digest, the queue and the
 * feature linker are mocked at their boundaries.
 */

const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

const CSID = '55555555-5555-4555-8555-555555555555';
const LPID = '66666666-6666-4666-8666-666666666666';
const UID = '77777777-7777-4777-8777-777777777777';
const PHONE = '15550003333';

let mocks;
let db;

const USER = { id: UID, name: 'Sample Teacher', phone_number: PHONE, preferred_language: 'en', grades_taught: ['4'], subjects_taught: ['maths'] };
const SESSION = {
  id: CSID, user_id: UID, status: 'completed', transcript_text: 'x'.repeat(4200), transcript_language: 'en',
  created_at: '2026-09-05T05:00:00Z', analysis_data: { topic: 'Fractions', subject: 'Maths' }, lesson_plan_excerpt: null,
  users: USER,
};
const DIGEST = (over = {}) => ({
  digest: {
    topic: 'Fractions', topic_as_taught: 'Fractions', subject: 'maths', grade_band: '3-5', language_of_instruction: 'en', confidence: 0.9,
    slos: [{ id: 'S1', statement: 'a', taught_level: 'recall' }, { id: 'S2', statement: 'b', taught_level: 'understand' }],
    ...over,
  },
  grade: '4', gradeSource: 'profile', lpHint: null, model: 'm', costUsd: 0,
});

function load({ quizzes = [] } = {}) {
  jest.resetModules();
  jest.doMock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
  mockBotDependency('aws-sdk', () => ({ config: { update: () => {} }, SQS: function SQS() {} }));
  jest.doMock('pdfkit', () => ({}), { virtual: true });
  const { makeSchemaDb } = require('./helpers/schema-db');
  db = makeSchemaDb({
    coaching_sessions: [SESSION],
    users: [USER],
    quizzes,
    lesson_plans: [{ id: LPID, user_id: UID, topic: 'Fractions', created_at: '2026-09-01T00:00:00Z' }],
    student_lists: [{ id: 'list-1', user_id: UID }],
    students: [{ id: 'kid-1', list_id: 'list-1', parent_phone: '15550009999' }],
  });
  jest.doMock('../../bot/shared/config/supabase', () => ({ from: db.from }));
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logError: jest.fn() }));
  jest.doMock('../../bot/shared/utils/structured-logger', () => ({
    logEvent: jest.fn(), getCurrentCorrelationId: () => 'c1', runWithCorrelation: (id, fn) => fn(), generateCorrelationId: () => 'c1',
  }));
  mocks = {
    whatsapp: {
      sendMessage: jest.fn().mockResolvedValue(true),
      sendInteractiveButtons: jest.fn().mockResolvedValue(true),
      sendDocument: jest.fn().mockResolvedValue(true),
    },
    linker: { suggestNext: jest.fn().mockResolvedValue(undefined) },
    queue: {
      queueJob: jest.fn().mockResolvedValue('mid'),
      extendQuizJobTimeout: jest.fn().mockResolvedValue(undefined),
      extendJobTimeout: jest.fn().mockResolvedValue(undefined),
    },
    digest: { run: jest.fn().mockResolvedValue(DIGEST()) },
    intro: { hasSeenIntroVideo: jest.fn().mockResolvedValue(false), markVideoShown: jest.fn().mockResolvedValue(undefined) },
  };
  jest.doMock('../../bot/shared/services/whatsapp.service', () => mocks.whatsapp);
  jest.doMock('../../bot/shared/services/feature-linker.service', () => mocks.linker);
  jest.doMock('../../bot/shared/services/queue', () => mocks.queue);
  jest.doMock('../../bot/shared/services/quiz/transcript-quiz-digest.service', () => mocks.digest);
  jest.doMock('../../bot/shared/services/feature-intro.service', () => mocks.intro);
  jest.doMock('../../bot/shared/services/coaching-orchestrator.service', () => ({}));
  jest.doMock('../../bot/workers/lesson-plan-extraction.worker', () => ({}));
  jest.doMock('../../bot/workers/lesson-plan-generation.worker', () => ({}));
  jest.doMock('../../bot/workers/video-generation.worker', () => ({}));
  jest.doMock('../../bot/workers/exam-grading.worker', () => ({}));
  const Offer = require('../../bot/shared/services/quiz/transcript-quiz-offer.service');
  const { SQSCoachingWorker } = require('../../bot/workers/sqs-worker');
  const worker = new SQSCoachingWorker('test-worker');
  // The quiz_offer job as the queue delivers it (v2 envelope); resolves to what processOffer answered.
  const runJob = async (id, payload) => {
    const spy = jest.spyOn(Offer, 'processOffer');
    await worker.executeJob(id, 'quiz_offer', payload, 'rh-1', 'quiz', { version: '2.0', groupId: id, payload });
    const result = await spy.mock.results[spy.mock.results.length - 1].value;
    spy.mockRestore();
    return result;
  };
  return {
    Offer: { processOffer: runJob },
    RG: require('../../bot/shared/services/coaching/report-generator.service'),
  };
}

const classicOfferSent = () => mocks.whatsapp.sendInteractiveButtons.mock.calls
  .filter(([, msg]) => (msg.buttons || []).some((b) => b.id === `quiz_yes_send_${LPID}`)).length;
const lessonQuizOfferSent = () => mocks.whatsapp.sendInteractiveButtons.mock.calls
  .filter(([, msg]) => (msg.buttons || []).some((b) => /^tq_yes_/.test(b.id))).length;

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV, TRANSCRIPT_QUIZ_ENABLED: 'true', QUIZ_LANGUAGES: 'en' };
  delete process.env.TRANSCRIPT_QUIZ_OFFER_MODE;
  delete process.env.TRANSCRIPT_QUIZ_SUBJECTS;
});
afterEach(() => { jest.resetModules(); process.env = { ...ENV }; });

/** What the report schedules, as the queue received it. */
async function scheduledPayload(RG) {
  await RG.afterReportOffers(SESSION, CSID, PHONE, { topic: 'Fractions' });
  const call = mocks.queue.queueJob.mock.calls.find((c) => c[1] === 'quiz_offer');
  return call && call[2];
}

describe('the offer job decides not to offer', () => {
  test('low confidence: the held-back Trigger 3 and suggestNext run from the job', async () => {
    const { Offer, RG } = load();
    const payload = await scheduledPayload(RG);
    expect(payload).toBeDefined();
    // The report held both back.
    expect(classicOfferSent()).toBe(0);
    expect(mocks.linker.suggestNext).not.toHaveBeenCalled();

    mocks.digest.run.mockResolvedValue(DIGEST({ confidence: 0.2 }));
    const r = await Offer.processOffer(CSID, payload);
    expect(r.skipped).toBe('low_confidence');
    expect(classicOfferSent()).toBe(1);
    expect(mocks.linker.suggestNext).toHaveBeenCalledWith('coaching', UID, PHONE, 'en', { coachingSessionId: CSID });
  });

  test('a redelivery of the skipped job does not send them twice', async () => {
    const { Offer, RG } = load();
    const payload = await scheduledPayload(RG);
    mocks.digest.run.mockResolvedValue(DIGEST({ slos: [] }));
    await Offer.processOffer(CSID, payload);
    await Offer.processOffer(CSID, payload);
    expect(classicOfferSent()).toBe(1);
    expect(mocks.linker.suggestNext).toHaveBeenCalledTimes(1);
  });

  test('the early (survey) job skipped first: the scheduled job that follows runs them, once', async () => {
    const { Offer, RG } = load();
    const payload = await scheduledPayload(RG);
    mocks.digest.run.mockResolvedValue(DIGEST({ confidence: 0.1 }));
    await Offer.processOffer(CSID, { coachingSessionId: CSID, early: true });
    expect(classicOfferSent()).toBe(0);
    await Offer.processOffer(CSID, payload);
    expect(classicOfferSent()).toBe(1);
    expect(mocks.linker.suggestNext).toHaveBeenCalledTimes(1);
  });

  test('the offer WAS made: no follow-ups from the job', async () => {
    const { Offer, RG } = load();
    const payload = await scheduledPayload(RG);
    const r = await Offer.processOffer(CSID, payload);
    expect(r.ok).toBe(true);
    expect(lessonQuizOfferSent()).toBe(1);
    expect(classicOfferSent()).toBe(0);
    expect(mocks.linker.suggestNext).not.toHaveBeenCalled();
  });
});

describe('an offer that was not delivered', () => {
  test('is not marked as "had the offer", so once-mode offers again next time', async () => {
    const { Offer, RG } = load();
    const payload = await scheduledPayload(RG);
    mocks.whatsapp.sendInteractiveButtons.mockResolvedValue(false);
    await Offer.processOffer(CSID, payload);
    expect(mocks.intro.markVideoShown).not.toHaveBeenCalled();
  });

  test('a delivered one is', async () => {
    const { Offer, RG } = load();
    const payload = await scheduledPayload(RG);
    await Offer.processOffer(CSID, payload);
    expect(mocks.intro.markVideoShown).toHaveBeenCalledWith(UID, 'transcript_quiz');
  });
});

describe('flag off: the report behaves exactly as main', () => {
  test('no offer is scheduled and Trigger 3 + suggestNext run from the report, once', async () => {
    delete process.env.TRANSCRIPT_QUIZ_ENABLED;
    const { RG } = load();
    await RG.afterReportOffers(SESSION, CSID, PHONE, { topic: 'Fractions' });
    expect(mocks.queue.queueJob).not.toHaveBeenCalled();
    expect(classicOfferSent()).toBe(1);
    expect(mocks.linker.suggestNext).toHaveBeenCalledTimes(1);
    expect(mocks.linker.suggestNext).toHaveBeenCalledWith('coaching', UID, PHONE, 'en', { coachingSessionId: CSID });
  });
});
