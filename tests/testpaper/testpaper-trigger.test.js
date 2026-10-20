/**
 * testpaper-trigger — how text reaches the /testpaper conversation, kept out
 * of text-message.handler so it is testable without the handler's whole
 * dependency graph (the homework-trigger convention).
 *
 *   /testpaper [subject], /paper [subject]  → start
 *   /mypapers, /testpaper my papers         → my papers
 *   anything else, while a pick is pending  → the conversation reads it
 */

let Trigger;
let O;

beforeEach(() => {
  jest.resetModules();
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  O = { start: jest.fn(), showMyPapers: jest.fn(), handleText: jest.fn().mockResolvedValue(false) };
  jest.doMock('../../bot/shared/services/testpaper/testpaper-orchestrator.service', () => O);
  Trigger = require('../../bot/shared/handlers/testpaper-trigger');
});

describe('parseTestPaperCommand', () => {
  it.each([
    ['/testpaper', { command: 'start', args: '' }],
    ['/TestPaper science', { command: 'start', args: 'science' }],
    ['/paper', { command: 'start', args: '' }],
    ['/paper  Grade 4 maths ', { command: 'start', args: 'Grade 4 maths' }],
    ['/test paper', { command: 'start', args: '' }],
    ['/mypapers', { command: 'mine', args: '' }],
    ['/my papers', { command: 'mine', args: '' }],
  ])('%p', (text, expected) => {
    expect(Trigger.parseTestPaperCommand(text)).toEqual(expected);
  });

  it.each(['/papers', '/paperclip', '/reading test', 'make a test paper', '/assessment', ''])('%p is not ours', (text) => {
    expect(Trigger.parseTestPaperCommand(text)).toBeNull();
  });
});

describe('routeTestPaperText', () => {
  const ctx = { user: { id: 'u1' }, from: 'matrix:@t:example.org', language: 'en' };

  it('starts the conversation for the command, with its argument', async () => {
    expect(await Trigger.routeTestPaperText({ ...ctx, messageBody: '/paper science' })).toBe(true);
    expect(O.start).toHaveBeenCalledWith({ user: ctx.user, from: ctx.from, args: 'science', language: 'en' });
  });

  it('opens my papers', async () => {
    expect(await Trigger.routeTestPaperText({ ...ctx, messageBody: '/mypapers' })).toBe(true);
    expect(O.showMyPapers).toHaveBeenCalledWith({ user: ctx.user, from: ctx.from, language: 'en' });
  });

  it('passes other text to the conversation, and reports whether it was consumed', async () => {
    O.handleText.mockResolvedValueOnce(true);
    expect(await Trigger.routeTestPaperText({ ...ctx, messageBody: '1,3' })).toBe(true);
    expect(O.handleText).toHaveBeenCalledWith({ user: ctx.user, from: ctx.from, text: '1,3', language: 'en' });
    expect(await Trigger.routeTestPaperText({ ...ctx, messageBody: 'hello' })).toBe(false);
  });

  it('a conversation error never swallows the message', async () => {
    O.handleText.mockRejectedValueOnce(new Error('redis down'));
    expect(await Trigger.routeTestPaperText({ ...ctx, messageBody: '1' })).toBe(false);
  });

  it('without an account the command still answers (the conversation says why)', async () => {
    expect(await Trigger.routeTestPaperText({ ...ctx, user: null, messageBody: '/testpaper' })).toBe(true);
    expect(O.start).toHaveBeenCalled();
    expect(await Trigger.routeTestPaperText({ ...ctx, user: null, messageBody: '1' })).toBe(false);
  });
});

describe('routeTestPaperSelection / routeTestPaperDocument (whatsapp-bot.js)', () => {
  beforeEach(() => {
    O.handleSelection = jest.fn().mockResolvedValue(true);
    O.handleDocument = jest.fn().mockResolvedValue(false);
    O.isTestPaperId = (id) => String(id).startsWith('tp_');
  });

  it('a tp_ id goes to the conversation in the teacher\'s language', async () => {
    jest.doMock('../../bot/shared/utils/language-cache', () => ({ getUserLanguage: jest.fn().mockResolvedValue('ur') }));
    Trigger = require('../../bot/shared/handlers/testpaper-trigger');
    expect(await Trigger.routeTestPaperSelection({ user: { id: 'u1' }, from: 'f', id: 'tp_mix_quick' })).toBe(true);
    expect(O.handleSelection).toHaveBeenCalledWith({ user: { id: 'u1' }, from: 'f', id: 'tp_mix_quick', language: 'ur' });
  });

  it('any other id is not ours', async () => {
    expect(await Trigger.routeTestPaperSelection({ user: { id: 'u1' }, from: 'f', id: 'quiz_class_1' })).toBe(false);
    expect(O.handleSelection).not.toHaveBeenCalled();
  });

  it('a document is offered to the conversation first, and passed on when not taken', async () => {
    jest.doMock('../../bot/shared/utils/language-cache', () => ({ getUserLanguage: jest.fn().mockResolvedValue('en') }));
    Trigger = require('../../bot/shared/handlers/testpaper-trigger');
    const message = { document: { id: 'm1' } };
    expect(await Trigger.routeTestPaperDocument({ user: { id: 'u1' }, from: 'f', message })).toBe(false);
    expect(O.handleDocument).toHaveBeenCalledWith({ user: { id: 'u1' }, from: 'f', message, language: 'en' });
  });
});
