/**
 * Every "is a Flow id set? then open the Flow" gate asks the channel too.
 *
 * These handlers are too large to drive in a unit test, and each gate is one
 * line, so this pins the line: the Flow id a gate reads must go through
 * channel-capabilities' nativeFlowIdFor(to, id). On a Matrix or Baileys
 * teacher it comes back empty and the gate takes its existing no-Flow path
 * (a text summary, or an honest "not available"), instead of a sendFlow()
 * that returns false and leaves the teacher with silence.
 *
 * Registration, exam confirmation and Reading-from-the-menu have behaviour
 * tests of their own (tests/registration, tests/exam-checker, tests/menu).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

const GATES = [
  ['bot/shared/handlers/text-message.handler.js', 'STATUS_FLOW_ID'],
  ['bot/shared/handlers/text-message.handler.js', 'HOMEWORK_FLOW_ID'],
  ['bot/shared/handlers/text-message.handler.js', 'EDIT_CLASS_FLOW_ID'],
  ['bot/whatsapp-bot.js', 'EDIT_CLASS_FLOW_ID'],
  ['bot/shared/services/quiz/quiz-intent-router.service.js', 'QUIZ_FLOW_ID'],
  ['bot/shared/services/quiz/quiz-intent-router.service.js', 'EDIT_CLASS_FLOW_ID'],
  ['bot/shared/services/feature-registration.service.js', 'REGISTRATION_FLOW_ID'],
];

describe('Flow-id gates are channel-aware', () => {
  it.each(GATES)('%s reads %s through nativeFlowIdFor()', (rel, flowVar) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(src).toMatch(new RegExp(`nativeFlowIdFor\\([^;]*\\b${flowVar}\\b`));
  });
});
