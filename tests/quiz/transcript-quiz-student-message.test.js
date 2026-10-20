'use strict';
/**
 * The message a teacher forwards to the class carries the join line the
 * channel allows (video-quiz-share `joinInvite` → {kind, link, code, bot}):
 *
 *   wa      → tqStudentMessage      the wa.me link alone (it opens the chat with the code typed)
 *   matrix  → tqStudentMessageJoin  the link to the bot's account AND the code to send there
 *   code    → tqStudentMessageCode  no link at all: the code and the bot's name
 *
 * A Matrix or Slack class must never be handed a wa.me link.
 */
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const Gen = require('../../bot/shared/services/quiz/transcript-quiz-generate.service');
const Render = require('../../bot/shared/services/quiz/transcript-quiz-render');

const BASE = { teacherName: 'Sam', topic: 'Comparing fractions', date: '2 October', language: 'en' };

describe('studentMessage picks the copy by the join invite', () => {
  test('wa: the wa.me link, and no separate code line', () => {
    const msg = Gen.studentMessage({
      ...BASE, invite: { kind: 'wa', link: 'https://wa.me/15550001111?text=QUIZ-ABC123', code: 'ABC123', bot: 'Rumi' },
    });
    expect(msg).toContain('https://wa.me/15550001111?text=QUIZ-ABC123');
    expect(msg).not.toContain('*QUIZ-ABC123*');
  });

  test('matrix: the matrix.to link and the code to send, never wa.me', () => {
    const msg = Gen.studentMessage({
      ...BASE, invite: { kind: 'matrix', link: 'https://matrix.to/#/@rumi:example.org', code: 'ABC123', bot: 'Rumi' },
    });
    expect(msg).toContain('https://matrix.to/#/@rumi:example.org');
    expect(msg).toContain('QUIZ-ABC123');
    expect(msg).toContain('Rumi');
    expect(msg).not.toMatch(/wa\.me/);
  });

  test('code: the code and the bot\'s name, no link at all', () => {
    const msg = Gen.studentMessage({
      ...BASE, invite: { kind: 'code', link: null, code: 'ABC123', bot: 'Rumi' },
    });
    expect(msg).toContain('QUIZ-ABC123');
    expect(msg).toContain('Rumi');
    expect(msg).not.toMatch(/https?:\/\//);
  });

  test('a caller that still passes a bare link gets the wa.me form', () => {
    const msg = Gen.studentMessage({ ...BASE, link: 'https://wa.me/15550001111?text=QUIZ-ABC123' });
    expect(msg).toContain('https://wa.me/15550001111?text=QUIZ-ABC123');
  });

  test('the same function is the render module\'s (one implementation, re-exported)', () => {
    expect(Gen.studentMessage).toBe(Render.studentMessage);
    expect(Gen.renderPdf).toBe(Render.renderPdf);
    expect(Gen.pdfFilename).toBe(Render.pdfFilename);
    expect(Gen.withFigureSvgs).toBe(Render.withFigureSvgs);
  });
});
