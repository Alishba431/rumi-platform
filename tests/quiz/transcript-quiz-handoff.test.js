'use strict';
/**
 * The hand-off: the teacher's PDF, then the message they forward to the class.
 *
 * The forwardable message brings each child to the bot on the channel the class
 * is on — the teacher's own. Its join line comes from the share service's
 * joinInvite({code, recipient}): a wa.me link for a WhatsApp teacher, a
 * matrix.to link plus the code for a Matrix teacher, the code alone otherwise.
 * A Matrix teacher must never be handed a wa.me link: it opens WhatsApp.
 *
 * The share service and the generate service belong to other parts of the
 * lane; they are replaced at the require boundary by fakes that follow their
 * contracts (joinInvite's channel rule; studentMessage choosing the message by
 * the invite's kind), so this suite tests the hand-off's own decisions.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendDocument: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/storage/r2', () => ({
  isR2Configured: jest.fn(() => false),
  uploadBuffer: jest.fn().mockResolvedValue('https://r2.example.org/x.pdf'),
  downloadFromR2: jest.fn().mockResolvedValue(Buffer.from('%PDF-stored')),
}));
jest.mock('../../bot/shared/services/quiz/video-quiz-share.service', () => ({
  mintCode: jest.fn(async () => ({ id: '88888888-8888-4888-8888-888888888888', code: 'ABC123', teacherName: 'Teacher Example' })),
  botNumber: jest.fn(() => '15550109999'),
  // joinInvite's contract: bare phone → wa.me; matrix:/mtx: → matrix.to + code; else the code.
  joinInvite: jest.fn(({ code, recipient }) => {
    const r = String(recipient || '');
    if (/^\d+$/.test(r)) return { kind: 'wa', link: `https://wa.me/15550109999?text=QUIZ-${code}`, bot: 'Rumi', code };
    if (/^(matrix:|mtx:)/.test(r)) return { kind: 'matrix', link: 'https://matrix.to/#/@rumi:example.org', bot: 'Rumi', code };
    return { kind: 'code', link: null, bot: 'Rumi', code };
  }),
}));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-render', () => {
  const { resolveUx } = jest.requireActual('../../bot/shared/config/ux-strings');
  return {
    // studentMessage's contract: the message shape follows the invite's kind.
    studentMessage: jest.fn(({ teacherName, topic, date, invite, language }) => {
      const params = { teacher: teacherName, topic, date };
      if (invite.kind === 'wa') return resolveUx('tqStudentMessage', { language, params: { ...params, link: invite.link } });
      if (invite.kind === 'matrix') {
        return resolveUx('tqStudentMessageJoin', { language, params: { ...params, link: invite.link, code: invite.code, bot: invite.bot } });
      }
      return resolveUx('tqStudentMessageCode', { language, params: { ...params, code: invite.code, bot: invite.bot } });
    }),
    renderPdf: jest.fn(async () => Buffer.from('%PDF-rendered')),
    withFigureSvgs: jest.fn((rows) => rows),
    pdfFilename: jest.fn(() => 'Quiz_Magnets.pdf'),
  };
});
jest.mock('../../bot/shared/services/quiz/transcript-quiz-language', () => require('./helpers/language-mock').factory());
jest.mock('../../bot/shared/services/quiz/teacher-self-test', () => require('./helpers/language-mock').selfTestFactory());
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Queue = require('../../bot/shared/services/queue');
const R2 = require('../../bot/shared/storage/r2');
const Share = require('../../bot/shared/services/quiz/video-quiz-share.service');
const { makeSchemaDb } = require('./helpers/schema-db');
const Handoff = require('../../bot/shared/services/quiz/transcript-quiz-handoff.service');

const QID = '22222222-2222-4222-8222-222222222222';
const UID = '33333333-3333-4333-8333-333333333333';
const SESS = '44444444-4444-4444-8444-444444444444';
const WA_TEACHER = '15550100001';
const MX_TEACHER = 'matrix:@teacher:example.org';

let db;
function install(quizOver = {}) {
  db = makeSchemaDb({
    users: [{ id: UID, name: 'Teacher Example', preferred_language: 'en', phone_number: WA_TEACHER }],
    coaching_sessions: [{ id: SESS, user_id: UID, status: 'completed', created_at: '2026-09-30T08:00:00Z' }],
    quizzes: [{
      id: QID, teacher_id: UID, quiz_source: 'transcript', coaching_session_id: SESS, topic: 'Magnets', subject: 'science',
      language: 'en', status: 'ready', meta: { digest: { topic: 'Magnets', subject: 'science' }, source: 'list' }, ...quizOver,
    }],
    quiz_questions: [{ quiz_id: QID, external_id: 'q1', question_text: 'Which metal sticks?', sort_order: 1 }],
  });
  supabase.from.mockImplementation(db.from);
}
const sentTexts = () => WhatsAppService.sendMessage.mock.calls.map((c) => String(c[1]));

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Handoff, 'sleep').mockResolvedValue(undefined);
  process.env = { ...ENV, QUIET_HOURS: 'off', SCHOOL_TIMEZONE: 'UTC' };
  delete process.env.TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES;
});
afterEach(() => { jest.useRealTimers(); });
afterAll(() => { process.env = ENV; });

describe('the forwardable message follows the teacher\'s channel', () => {
  test('a Matrix teacher gets a matrix.to link and the code — never wa.me', async () => {
    install();
    const out = await Handoff.sendHandoff(QID, MX_TEACHER, { firstSend: true });
    expect(out.ok).toBe(true);
    expect(Share.joinInvite).toHaveBeenCalledWith({ code: 'ABC123', recipient: MX_TEACHER });
    const texts = sentTexts();
    const forwardable = texts.find((t) => t.includes('QUIZ-ABC123'));
    expect(forwardable).toContain('https://matrix.to/#/@rumi:example.org');
    texts.forEach((t) => expect(t).not.toMatch(/wa\.me/));
    const meta = db.table('quizzes')[0].meta;
    expect(meta.link).toBe('https://matrix.to/#/@rumi:example.org');
    expect(meta.join_kind).toBe('matrix');
    expect(meta.student_message).toBe(forwardable);
    // The later sends (the nudge, the class report) go to the chat this went to.
    expect(meta.teacher_to).toBe(MX_TEACHER);
  });

  test('a WhatsApp teacher gets the wa.me link that opens the chat with the code typed', async () => {
    install();
    await Handoff.sendHandoff(QID, WA_TEACHER, { firstSend: true });
    const forwardable = sentTexts().find((t) => t.includes('wa.me'));
    expect(forwardable).toContain('https://wa.me/15550109999?text=QUIZ-ABC123');
  });

  test('where no link is possible the class is told the code and the bot to send it to', async () => {
    install();
    await Handoff.sendHandoff(QID, 'slack:U0TEACHER', { firstSend: true });
    const forwardable = sentTexts().find((t) => t.includes('QUIZ-ABC123'));
    expect(forwardable).toContain('Rumi');
    expect(forwardable).not.toMatch(/https?:\/\//);
    expect(db.table('quizzes')[0].meta.link).toBeNull();
  });

  test('a resend is the same code and the same message — nothing is minted again', async () => {
    install();
    await Handoff.sendHandoff(QID, MX_TEACHER, { firstSend: true });
    const first = db.table('quizzes')[0].meta.student_message;
    WhatsAppService.sendMessage.mockClear();
    const out = await Handoff.sendHandoff(QID, MX_TEACHER, { firstSend: false });
    expect(out).toEqual(expect.objectContaining({ ok: true, code: 'ABC123', reused: true }));
    expect(Share.mintCode).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toContain(first);
  });
});

describe('the PDF', () => {
  test('without R2 the PDF is rendered and sent from a temp file, and nothing is uploaded', async () => {
    install();
    const out = await Handoff.sendHandoff(QID, WA_TEACHER, { firstSend: true });
    expect(out.pdfSent).toBe(true);
    expect(R2.uploadBuffer).not.toHaveBeenCalled();
    const [to, filePath, filename] = WhatsAppService.sendDocument.mock.calls[0];
    expect(to).toBe(WA_TEACHER);
    expect(filePath).toMatch(/transcript-quiz-.*\.pdf$/);
    expect(filename).toBe('Quiz_Magnets.pdf');
    expect(db.table('quizzes')[0].meta.pdf_key).toBeNull();
  });

  test('with R2 the rendered PDF is stored, and a resend fetches it instead of rendering again', async () => {
    R2.isR2Configured.mockReturnValue(true);
    install();
    await Handoff.sendHandoff(QID, WA_TEACHER, { firstSend: true });
    expect(R2.uploadBuffer).toHaveBeenCalledTimes(1);
    const Gen = require('../../bot/shared/services/quiz/transcript-quiz-render');
    Gen.renderPdf.mockClear();
    await Handoff.sendHandoff(QID, WA_TEACHER, { firstSend: false });
    expect(R2.downloadFromR2).toHaveBeenCalledWith(`transcript_quizzes/${UID}/${QID}.pdf`);
    expect(Gen.renderPdf).not.toHaveBeenCalled();
    R2.isR2Configured.mockReturnValue(false);
  });
});

describe('the nudge is scheduled on the first send', () => {
  const nudgeJob = () => Queue.queueJob.mock.calls.find((c) => c[1] === 'quiz_nudge_teacher');

  test('TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES sets the wait, and a short wait is not held for 15 minutes', async () => {
    process.env.TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES = '2';
    install();
    const before = Date.now();
    await Handoff.sendHandoff(QID, WA_TEACHER, { firstSend: true });
    const [, , payload, opts] = nudgeJob();
    const target = Date.parse(payload.targetAt);
    expect(target - before).toBeGreaterThanOrEqual(2 * 60 * 1000 - 50);
    expect(target - before).toBeLessThan(3 * 60 * 1000);
    expect(opts.delaySeconds).toBeLessThanOrEqual(120);
  });

  test('the default wait is six hours, moved out of the school\'s quiet hours in SCHOOL_TIMEZONE', async () => {
    process.env.QUIET_HOURS = '21-7';
    process.env.SCHOOL_TIMEZONE = 'Africa/Nairobi';                 // UTC+3, no daylight saving
    jest.useFakeTimers({ now: new Date('2026-10-01T14:00:00Z') });  // 17:00 school time; +6 h = 23:00
    install();
    await Handoff.sendHandoff(QID, WA_TEACHER, { firstSend: true });
    const [, , payload, opts] = nudgeJob();
    expect(payload.targetAt).toBe('2026-10-02T04:00:00.000Z');      // 07:00 next morning, school time
    expect(opts.delaySeconds).toBe(900);
    expect(opts.deduplicationId).toBe(`${QID}-quiz_nudge_teacher`);
  });

  test('a resend schedules no second nudge', async () => {
    install();
    await Handoff.sendHandoff(QID, WA_TEACHER, { firstSend: true });
    Queue.queueJob.mockClear();
    await Handoff.sendHandoff(QID, WA_TEACHER, { firstSend: false });
    expect(nudgeJob()).toBeUndefined();
  });
});

describe('the report promise names the school\'s own morning', () => {
  test('the hour is the end of QUIET_HOURS, not a fixed 7 am', async () => {
    process.env.QUIET_HOURS = '22-6';
    install();
    await Handoff.sendHandoff(QID, MX_TEACHER, { firstSend: true });
    const promise = sentTexts().find((t) => /report on how the class did/.test(t));
    expect(promise).toMatch(/at 6:00 if that falls at night/);
  });

  test('with quiet hours off the promise names no hour', async () => {
    install();
    await Handoff.sendHandoff(QID, MX_TEACHER, { firstSend: true });
    const promise = sentTexts().find((t) => /report on how the class did/.test(t));
    expect(promise).toBeDefined();
    expect(promise).not.toMatch(/at night/);
  });
});
