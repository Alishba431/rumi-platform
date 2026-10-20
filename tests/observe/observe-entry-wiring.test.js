/**
 * Source guard for the webhook entry point (bot/whatsapp-bot.js boots a
 * server on require, so it is checked statically; the live path is proven by
 * the Matrix end-to-end run). Three hooks must exist:
 *  - button taps and list picks with an observe_ id go to the observe
 *    dispatcher before any other branch can claim them;
 *  - an audio FILE from a coach goes through the observe audio router before
 *    the 15-minute self-coaching check — a 40-minute lesson usually arrives
 *    as a file, and without this it would start the coach's own coaching.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../bot/whatsapp-bot.js'), 'utf8');

function sliceFrom(marker, length = 1500) {
  const i = src.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, i + length);
}

describe('observe hooks in whatsapp-bot.js', () => {
  test('button_reply: observe_ ids are dispatched first', () => {
    const block = sliceFrom("logToFile('📱 Interactive button clicked'", 600);
    expect(block).toMatch(/buttonId\.startsWith\('observe_'\)[\s\S]*handleObserveInteractive\(user, from, buttonId\)/);
  });

  test('list_reply: observe_ ids are dispatched first', () => {
    const block = sliceFrom("logToFile('📋 Interactive list item selected'", 600);
    expect(block).toMatch(/listId\.startsWith\('observe_'\)[\s\S]*handleObserveInteractive\(user, from, listId\)/);
  });

  test('audio documents pass the observe router before the classroom-coaching threshold', () => {
    const doc = sliceFrom('if (isAudioDocument) {', 4000);
    const router = doc.indexOf('routeLeaderAudio(');
    const threshold = doc.indexOf('if (audioDurationRounded >= CLASSROOM_AUDIO_THRESHOLD)');
    expect(router).toBeGreaterThan(-1);
    expect(router).toBeLessThan(threshold);
  });
});
