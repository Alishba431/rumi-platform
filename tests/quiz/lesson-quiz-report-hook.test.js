'use strict';
/**
 * The coaching report's hand-over to the lesson quiz.
 *
 * After a report is delivered the teacher used to get two asks: Trigger 3 (a
 * quiz to their students' parents, buttons `quiz_yes_send_<lessonPlanId>`)
 * and a next-feature suggestion. When the lesson-quiz offer is scheduled for
 * this session, both stay quiet — one ask at a time, and the offer is about a
 * quiz too. When it is not (flag off, short transcript, any refusal), both
 * run exactly as before.
 *
 * The real ReportGeneratorService runs, including the real
 * offerQuizAfterReport; the boundary (supabase, the WhatsApp facade, the
 * offer service, the feature linker) is mocked.
 */

const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

const CSID = '55555555-5555-4555-8555-555555555555';
const LPID = '66666666-6666-4666-8666-666666666666';
const PHONE = '15550003333';

let mocks;

function makeSupabase() {
  const rows = {
    lesson_plans: { id: LPID, topic: 'Fractions' },
    student_lists: [{ id: 'list-1' }],
    students: [{ id: 'kid-1' }],
  };
  return {
    from: jest.fn((table) => {
      const value = rows[table];
      const b = {
        select: () => b, eq: () => b, not: () => b, order: () => b, limit: () => b,
        single: () => Promise.resolve({ data: value || null, error: null }),
        then: (resolve) => resolve({ data: value || null, error: null }),
      };
      return b;
    }),
  };
}

function load({ scheduleOffer } = {}) {
  jest.resetModules();
  // gpt5-mini.service (reached through the real route) needs jsonrepair, a bot-only
  // dependency the root suite runs without.
  jest.doMock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
  mockBotDependency('aws-sdk', () => ({ config: { update: () => {} }, SQS: function SQS() {} }));
  jest.doMock('pdfkit', () => ({}), { virtual: true });
  jest.doMock('../../bot/shared/config/supabase', () => makeSupabase());
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logError: jest.fn() }));
  mocks = {
    whatsapp: {
      sendMessage: jest.fn().mockResolvedValue(true),
      sendInteractiveButtons: jest.fn().mockResolvedValue(true),
      sendDocument: jest.fn().mockResolvedValue(true),
    },
    linker: { suggestNext: jest.fn().mockResolvedValue(undefined) },
    offer: { scheduleOffer: scheduleOffer || jest.fn().mockResolvedValue(false) },
  };
  jest.doMock('../../bot/shared/services/whatsapp.service', () => mocks.whatsapp);
  jest.doMock('../../bot/shared/services/feature-linker.service', () => mocks.linker);
  jest.doMock('../../bot/shared/services/quiz/transcript-quiz-offer.service', () => mocks.offer);
  return require('../../bot/shared/services/coaching/report-generator.service');
}

const session = () => ({
  id: CSID,
  user_id: 'teacher-1',
  transcript_language: 'en',
  transcript_text: 'x'.repeat(4200),
  users: { phone_number: PHONE, first_name: 'Sam', last_name: 'Teacher' },
});

const classicOfferSent = () => mocks.whatsapp.sendInteractiveButtons.mock.calls
  .some(([, msg]) => (msg.buttons || []).some((b) => b.id === `quiz_yes_send_${LPID}`));

afterEach(() => jest.resetModules());

describe('afterReportOffers — Trigger 3 and suggestNext vs the lesson-quiz offer', () => {
  test('lesson-quiz offer scheduled: the classic Trigger-3 offer is NOT sent and suggestNext is NOT called', async () => {
    const RG = load({ scheduleOffer: jest.fn().mockResolvedValue(true) });
    await RG.afterReportOffers(session(), CSID, PHONE, { topic: 'Fractions' });
    expect(classicOfferSent()).toBe(false);
    expect(mocks.linker.suggestNext).not.toHaveBeenCalled();
    expect(mocks.offer.scheduleOffer).toHaveBeenCalledTimes(1);
    // The report hook itself says nothing: the offer service owns the copy.
    expect(mocks.whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('lesson-quiz offer NOT scheduled (flag off / refused): Trigger 3 and suggestNext run as before', async () => {
    const RG = load({ scheduleOffer: jest.fn().mockResolvedValue(false) });
    await RG.afterReportOffers(session(), CSID, PHONE, { topic: 'Fractions' });
    expect(classicOfferSent()).toBe(true);
    expect(mocks.linker.suggestNext).toHaveBeenCalledWith('coaching', 'teacher-1', PHONE, 'en', { coachingSessionId: CSID });
  });

  test('the offer service throwing never breaks the report hook; the classic asks still run', async () => {
    const RG = load({ scheduleOffer: jest.fn().mockRejectedValue(new Error('redis down')) });
    await expect(RG.afterReportOffers(session(), CSID, PHONE, { topic: 'Fractions' })).resolves.toBeUndefined();
    expect(classicOfferSent()).toBe(true);
    expect(mocks.linker.suggestNext).toHaveBeenCalled();
  });
});

describe('scheduleTranscriptQuiz', () => {
  test('passes the session, teacher, recipient, report language and transcript length to scheduleOffer', async () => {
    const RG = load({ scheduleOffer: jest.fn().mockResolvedValue(true) });
    const ok = await RG.scheduleTranscriptQuiz(session(), CSID, PHONE, 'en');
    expect(ok).toBe(true);
    expect(mocks.offer.scheduleOffer).toHaveBeenCalledWith({
      coachingSessionId: CSID,
      userId: 'teacher-1',
      phone: PHONE,
      language: 'en',
      transcriptChars: 4200,
      source: 'self',
      reportTopic: undefined,
    });
  });

  test('falls back to the session phone when no recipient was passed, and coerces a truthy answer to true', async () => {
    const RG = load({ scheduleOffer: jest.fn().mockResolvedValue({ queued: 'msg-1' }) });
    const ok = await RG.scheduleTranscriptQuiz(session(), CSID, null, 'en');
    expect(ok).toBe(true);
    expect(mocks.offer.scheduleOffer).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE }));
  });

  test('returns false (never throws) when scheduling fails', async () => {
    const RG = load({ scheduleOffer: jest.fn().mockRejectedValue(new Error('boom')) });
    await expect(RG.scheduleTranscriptQuiz(session(), CSID, PHONE, 'en')).resolves.toBe(false);
  });
});

describe('generateReport hands over through afterReportOffers', () => {
  test('the report pipeline calls the post-report hook with the session, id, recipient and analysis', () => {
    // A source check, deliberately narrow: generateReport's real body needs the
    // PDF, voice and card pipelines; the hook's behaviour is executed above.
    const src = require('fs').readFileSync(
      require.resolve('../../bot/shared/services/coaching/report-generator.service'), 'utf8');
    expect(src).toMatch(/await this\.afterReportOffers\(session, coachingSessionId, from, enhancedAnalysis\)/);
  });
});
