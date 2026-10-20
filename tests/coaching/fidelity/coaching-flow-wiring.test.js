'use strict';
/**
 * whatsapp-bot.js and the text handler only DELEGATE to the coaching-flow modules (each tested on its own in
 * lp-step-flow.test.js). This pins the delegations, in the order that matters: the photo buttons and the plan
 * picker are routed before the generic handlers that would otherwise swallow them, and a pasted plan is taken
 * before the text reaches intent detection. The end-to-end run on the Matrix messenger exercises them live.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '../../../', p), 'utf8');

describe('coaching flow wiring', () => {
  const bot = read('bot/whatsapp-bot.js');

  test('photo buttons are routed before the coaching confirmation buttons', () => {
    const at = bot.indexOf("handleCoachingFlowButton(buttonId, from, user)");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(bot.indexOf("buttonId.startsWith('coaching_confirm_')"));
  });

  test('plan-picker list replies are routed before the generic list handling', () => {
    const at = bot.indexOf('handleLpListSelection(listId, from)');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(bot.indexOf('const currentSessionId = await getOrCreateSession(user.id);'));
  });

  test('a pasted plan is taken before intent detection', () => {
    const text = read('bot/shared/handlers/text-message.handler.js');
    const at = text.indexOf('handlePastedLessonPlan(user, from, messageBody)');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.indexOf('OpenAIService.detectIntent(messageBody)'));
  });
});
