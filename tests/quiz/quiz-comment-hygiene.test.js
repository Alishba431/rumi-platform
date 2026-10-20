'use strict';
/**
 * Comments in the lesson-quiz rendering files use neutral placeholders for
 * people and places, never real-looking names or real cities.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const FILES = [
  'bot/shared/templates/quiz-brand.js',
  'bot/shared/templates/video-quiz-report.template.js',
  'bot/shared/templates/video-quiz-scorecard.template.js',
  'bot/shared/templates/video-quiz-leaderboard.template.js',
  'bot/shared/templates/transcript-quiz-teacher.template.js',
  'bot/shared/utils/text-format.js',
  'bot/vendor/lp-v9/diagrams/types/fraction_bar.js',
  'tests/quiz/transcript-quiz-nudge.test.js',
];

const comments = (src) => (src.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) || []).join('\n');

test.each(FILES)('%s: no real-looking name or city in a comment', (rel) => {
  const text = comments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  expect(text).not.toMatch(/\bAli\b|\bSara\b|Ayesha|عائشہ|کنول|Karachi|Nairobi/);
});
