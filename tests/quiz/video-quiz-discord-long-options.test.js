'use strict';
/**
 * The Discord half of video-quiz-slack-long-options.test.js. A v1.2.0 video
 * quiz question whose options outgrow the 24-char row title reaches the
 * driver as rows titled "A".."D" with the option text in each row's
 * description. Discord's select options carry a 100-char description, so the
 * driver must pass it through or the child is left choosing between bare
 * letters. The facade payload itself (what Meta, Baileys and Matrix draw) is
 * pinned here too, so the fix stays in the drivers and WhatsApp/Matrix see
 * exactly what they saw before.
 */
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
jest.mock('../../bot/shared/services/quiz/video-quiz-rate-limiter.service', () => ({ throttle: jest.fn().mockResolvedValue() }));
const captured = [];
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendInteractiveMessage: jest.fn(async (to, data) => { captured.push(data); return true; }),
  sendInteractiveButtons: jest.fn(async (to, body, buttons) => { captured.push({ body: { text: body }, buttons }); return true; }),
  sendMessage: jest.fn().mockResolvedValue(true),
}));
// discord.js is a bot-only dependency (see tests/routes/discord-views.test.js);
// the builders here keep exactly what the driver hands them.
jest.mock('discord.js', () => {
  class StringSelectMenuBuilder {
    constructor() { this.options = []; }
    setCustomId(id) { this.customId = id; return this; }
    setPlaceholder(p) { this.placeholder = p; return this; }
    addOptions(opts) { this.options.push(...opts); return this; }
  }
  class ActionRowBuilder {
    constructor() { this.components = []; }
    addComponents(...c) { this.components.push(...c); return this; }
  }
  return { StringSelectMenuBuilder, ActionRowBuilder };
}, { virtual: true });
const sent = [];
jest.mock('../../bot/shared/services/messaging/discord-connection', () => ({
  getClient: jest.fn(async () => ({
    users: { fetch: jest.fn(async () => ({ send: jest.fn(async (p) => { sent.push(p); return { id: '1' }; }) })) },
  })),
}));

const render = require('../../bot/shared/services/quiz/video-quiz-render.service');
const sender = require('../../bot/shared/services/quiz/video-quiz-sender.service');

const OPTS = ['5 red pencils and 10 blue pencils', '8 red pencils and 15 blue pencils',
  '23 blue pencils, and 19 red pencils', '23 blue, 10 red, and 10 green pencils'];

async function sendLongOptionQuestion() {
  delete process.env.TRANSCRIPT_QUIZ_ENABLED;
  const q = {
    id: 'q1', question_text: 'What combination of pencils will make 43 pencils?',
    option_a: OPTS[0], option_b: OPTS[1], option_c: OPTS[2], option_d: OPTS[3],
    correct_option: 'C', explanation: '', option_feedback: null, media: {}, render_pattern: 'P1',
  };
  const msgs = render.build(q, { questionNumber: 1, totalQuestions: 5 });
  await sender.sendPhase('discord:U0TESTCHILD', msgs, 'interaction',
    { questionId: 'q1', sessionId: 's1', language: 'en', typedAnswers: false });
  expect(captured.length).toBe(1);
  return captured[0];
}

test('a Discord child sees every option of a long-option v1.2.0 video question (flag off)', async () => {
  const payload = await sendLongOptionQuestion();
  const discord = require('../../bot/shared/services/messaging/discord-channel.service');
  await expect(discord.sendInteractiveMessage('discord:U0TESTCHILD', payload)).resolves.toBe(true);
  expect(sent.length).toBe(1);
  const menu = sent[0].components[0].components[0];
  const visible = JSON.stringify([sent[0].content,
    menu.options.map((o) => o.label + (o.description ? ` ${o.description}` : ''))]);
  for (const o of OPTS) expect(visible).toContain(o);
  expect(menu.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D']);
});

test('the facade payload (what WhatsApp and Matrix draw) is unchanged: letter titles, full option as description', async () => {
  captured.length = 0;
  const payload = await sendLongOptionQuestion();
  const rows = payload.action.sections.flatMap((s) => s.rows);
  expect(rows.map((r) => r.title)).toEqual(['A', 'B', 'C', 'D']);
  // Display order is shuffled per send; the set of options is what must hold.
  expect(rows.map((r) => r.description).sort()).toEqual([...OPTS].sort());
});
