'use strict';
/**
 * The teacher chooses the quiz language.
 *
 * With more than one QUIZ_LANGUAGES, "yes" (and a /quiz pick) asks first, and
 * generation waits for the answer. With one, there is nothing to ask and the
 * quiz is made straight away. The ask lists exactly the configured languages —
 * `tq_lang_<code>_<quizId>` for whatever codes the deployment set.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
  sendInteractiveMessage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-digest.service', () => ({ run: jest.fn() }));
jest.mock('../../bot/shared/services/feature-intro.service', () => ({
  hasSeenIntroVideo: jest.fn().mockResolvedValue(true),
  markVideoShown: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-language', () => require('./helpers/language-mock').factory());
jest.mock('../../bot/shared/services/quiz/teacher-self-test', () => require('./helpers/language-mock').selfTestFactory());
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Queue = require('../../bot/shared/services/queue');
const Language = require('../../bot/shared/services/quiz/transcript-quiz-language');
const { installFrom } = require('./helpers/supabase-chain');
const Offer = require('../../bot/shared/services/quiz/transcript-quiz-offer.service');
const List = require('../../bot/shared/services/quiz/transcript-quiz-list.service');

const QID = '22222222-2222-4222-8222-222222222222';
const SESS = '44444444-4444-4444-8444-444444444444';
const PHONE = '15550100001';
const UID = '33333333-3333-4333-8333-333333333333';
const USER = { id: UID, preferred_language: 'en' };
const DIGEST = { topic: 'Fractions', subject: 'maths', slos: [] };

function quizRow(over = {}) {
  return {
    id: QID, teacher_id: UID, status: 'offered', language: 'en', subject: 'maths',
    topic: 'Fractions', coaching_session_id: 'cs-1', meta: { digest: DIGEST }, ...over,
  };
}

/** quizzes answers a read with `row`; an update answers with `updated` rows. */
function wireQuiz(row, { updated = [{ id: QID }], extra = {} } = {}) {
  installFrom(supabase.from, {
    quizzes: (calls) => (calls.some((c) => c[0] === 'update' || c[0] === 'insert')
      ? { data: updated } : { data: row ? [row] : [] }),
    users: { data: [{ id: UID, phone_number: PHONE, preferred_language: 'en' }] },
    ...extra,
  });
}

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, TRANSCRIPT_QUIZ_ENABLED: 'true', QUIZ_LANGUAGES: 'en,ur' };
});
afterAll(() => { process.env = ENV; });

describe('yes → the language ask', () => {
  test('asks before generating, offering the rule language first', async () => {
    wireQuiz(quizRow());
    expect(await Offer.handleOfferButton(`tq_yes_${QID}`, PHONE)).toBe(true);

    expect(Queue.queueJob).not.toHaveBeenCalled();
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledTimes(1);
    const [, payload] = WhatsAppService.sendInteractiveButtons.mock.calls[0];
    expect(payload.buttons.map((b) => b.id)).toEqual([`tq_lang_en_${QID}`, `tq_lang_ur_${QID}`]);
    expect(Language.languageAskButtons).toHaveBeenCalledWith(QID, 'en');

    const updates = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update');
    expect(updates[0][1].meta.awaiting_language).toBe(true);
    expect(updates[0][1].status).toBeUndefined();     // still 'offered' until they answer
  });

  test('the row it decides on is actually read with its subject', async () => {
    wireQuiz(quizRow());
    await Offer.handleOfferButton(`tq_yes_${QID}`, PHONE);
    const select = supabase.from.callsFor('quizzes').flat().find((c) => c[0] === 'select');
    expect(select[1]).toMatch(/\bsubject\b/);
    expect(Language.needsLanguageAsk).toHaveBeenCalledWith('maths');
  });

  test('a subject whose language is fixed is never asked — it goes straight to generating', async () => {
    Language.needsLanguageAsk.mockReturnValueOnce(false);
    wireQuiz(quizRow({ subject: 'french', language: 'en' }));
    await Offer.handleOfferButton(`tq_yes_${QID}`, PHONE);
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(Queue.queueJob).toHaveBeenCalledWith(QID, 'quiz_generate', expect.any(Object), expect.any(Object));
    const updates = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update');
    expect(updates[0][1].status).toBe('generating');
  });

  test('a quiz that is no longer offered says so instead of asking twice', async () => {
    wireQuiz(quizRow({ status: 'sent' }), { updated: [] });
    await Offer.handleOfferButton(`tq_yes_${QID}`, PHONE);
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    expect(Queue.queueJob).not.toHaveBeenCalled();
  });
});

describe('handleLanguageButton', () => {
  test('stores the chosen language, flips offered→generating once, and enqueues', async () => {
    let flips = 0;
    installFrom(supabase.from, {
      quizzes: (calls) => {
        if (calls.some((c) => c[0] === 'update')) {
          flips += 1;
          return flips === 1 ? { data: [{ id: QID }] } : { data: [] };
        }
        return { data: [quizRow({ meta: { digest: DIGEST, awaiting_language: true } })] };
      },
      users: { data: [{ id: UID, phone_number: PHONE, preferred_language: 'en' }] },
    });

    expect(await Offer.handleLanguageButton(`tq_lang_ur_${QID}`, PHONE, USER)).toBe(true);
    const updates = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update');
    expect(updates[0][1]).toEqual(expect.objectContaining({ status: 'generating', language: 'ur' }));
    expect(updates[0][1].meta.awaiting_language).toBe(false);
    expect(Queue.queueJob).toHaveBeenCalledWith(QID, 'quiz_generate', expect.any(Object), expect.any(Object));

    // A second tap changes nothing and never enqueues twice.
    expect(await Offer.handleLanguageButton(`tq_lang_en_${QID}`, PHONE, USER)).toBe(true);
    expect(Queue.queueJob).toHaveBeenCalledTimes(1);
  });

  test('any configured language code is understood, not only two fixed ones', async () => {
    process.env.QUIZ_LANGUAGES = 'en,fr';
    wireQuiz(quizRow());
    expect(await Offer.handleLanguageButton(`tq_lang_fr_${QID}`, PHONE, USER)).toBe(true);
    const updates = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update');
    expect(updates[0][1].language).toBe('fr');
    expect(Queue.queueJob).toHaveBeenCalledTimes(1);
  });

  test('a button for a language this deployment no longer offers asks again — nothing is written in it', async () => {
    process.env.QUIZ_LANGUAGES = 'en,fr';
    wireQuiz(quizRow());
    expect(await Offer.handleLanguageButton(`tq_lang_ur_${QID}`, PHONE, USER)).toBe(true);
    expect(Queue.queueJob).not.toHaveBeenCalled();
    const [, payload] = WhatsAppService.sendInteractiveButtons.mock.calls[0];
    expect(payload.buttons.map((b) => b.id)).toEqual([`tq_lang_en_${QID}`, `tq_lang_fr_${QID}`]);
  });

  test('a quiz that has gone away says the offer expired', async () => {
    wireQuiz(null);
    expect(await Offer.handleLanguageButton(`tq_lang_ur_${QID}`, PHONE, USER)).toBe(true);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    expect(Queue.queueJob).not.toHaveBeenCalled();
  });

  test('ignores buttons that are not ours', async () => {
    expect(await Offer.handleLanguageButton(`tq_yes_${QID}`, PHONE, USER)).toBe(false);
    expect(await Offer.handleLanguageButton('vq_offer_yes', PHONE, USER)).toBe(false);
    expect(await Offer.handleLanguageButton('tq_lang_x_not-a-quiz-id', PHONE, USER)).toBe(false);
  });
});

describe('/quiz pick → the language ask', () => {
  const SESSION = {
    id: SESS, user_id: UID, created_at: '2026-09-05T05:00:00Z',
    transcript_text: 'x'.repeat(3000), transcript_language: 'en',
    analysis_data: { topic: 'Fractions', subject: 'Maths' },
  };

  test('a lesson with no quiz yet is claimed as offered and awaiting the answer — nothing is generated', async () => {
    installFrom(supabase.from, {
      coaching_sessions: { data: [SESSION] },
      quizzes: (calls) => (calls.some((c) => c[0] === 'insert') ? { data: [{ id: QID }] } : { data: [] }),
      users: { data: [USER] },
    });
    expect(await List.handleListPick(`tq_pick_${SESS}`, PHONE, USER)).toBe(true);
    expect(Queue.queueJob).not.toHaveBeenCalled();
    const inserts = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'insert');
    expect(inserts[0][1].status).toBe('offered');
    expect(inserts[0][1].meta.awaiting_language).toBe(true);
    const [, payload] = WhatsAppService.sendInteractiveButtons.mock.calls[0];
    expect(payload.buttons.map((b) => b.id)).toEqual([`tq_lang_en_${QID}`, `tq_lang_ur_${QID}`]);
  });

  test('a declined lesson picked again asks the language rather than regenerating silently', async () => {
    installFrom(supabase.from, {
      coaching_sessions: { data: [SESSION] },
      quizzes: (calls) => (calls.some((c) => c[0] === 'update')
        ? { data: [{ id: QID }] }
        : { data: [quizRow({ status: 'declined' })] }),
      users: { data: [USER] },
    });
    expect(await List.handleListPick(`tq_pick_${SESS}`, PHONE, USER)).toBe(true);
    expect(Queue.queueJob).not.toHaveBeenCalled();
    const updates = supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update');
    expect(updates[0][1].status).toBe('offered');
    expect(updates[0][1].meta.awaiting_language).toBe(true);
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledTimes(1);
  });

  test('a one-language deployment never asks: the pick queues the quiz', async () => {
    process.env.QUIZ_LANGUAGES = 'en';
    installFrom(supabase.from, {
      coaching_sessions: { data: [SESSION] },
      quizzes: (calls) => (calls.some((c) => c[0] === 'insert') ? { data: [{ id: QID }] } : { data: [] }),
      users: { data: [USER] },
    });
    await List.handleListPick(`tq_pick_${SESS}`, PHONE, USER);
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(Queue.queueJob).toHaveBeenCalledWith(QID, 'quiz_generate', expect.any(Object), expect.any(Object));
  });
});
