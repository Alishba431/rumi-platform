/**
 * The Matrix channel's sources, tests and env docs use only fictional sample
 * identities: phone numbers in the +1 555 range and role names like
 * "@teacher", never a real-looking mobile number or a person's name. The
 * repo-wide INTERNAL_RE only covers agent docs, so without this the Matrix
 * modules (where phone-number usernames are the whole point) could reintroduce
 * one unnoticed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const MESSAGING = 'bot/shared/services/messaging';

function matrixFiles() {
  const pick = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).map((f) => `${dir}/${f}`);
  return [
    ...pick(MESSAGING, /^matrix-.*\.js$/),
    ...pick(`${MESSAGING}/inbound`, /^matrix-.*\.js$/),
    ...pick('tests/messaging', /^matrix-.*\.test\.js$/),
    'bot/scripts/matrix-smoke.js',
    // The text-flow copy is what a Matrix (or Baileys) teacher reads.
    `${MESSAGING}/text-flow-definitions.js`,
    '.env.template',
  ];
}

// A phone number is "fictional" here only in the +1 555 range. Anything else
// with 10+ digits after an optional +/t prefix (the two Matrix username forms)
// is treated as real-looking.
const PHONE_RE = /(?:^|[^\d])[+tT]?(\d{10,15})(?!\d)/g;
const NAME_RE = /@(?:kamal)\b/i;

describe('Matrix sample data is fictional', () => {
  it.each(matrixFiles())('%s', (rel) => {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
      if (!/mtx:|matrix|@\+|localpart|phone/i.test(line) && rel === '.env.template') return;
      for (const m of line.matchAll(PHONE_RE)) {
        if (!m[1].startsWith('1555')) offenders.push(`${rel}:${i + 1}: ${m[1]}`);
      }
      if (NAME_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
