'use strict';
/**
 * A colour the author model writes must never reach the figure HTML as markup.
 *
 * Latin labels go through the engine's escaping attrs(); Urdu labels take the
 * foreignObject path, where the colour lands inside a style="" attribute. A
 * colour such as `red"><img src=x onerror=…>` used to close that attribute and
 * plant a live element in the page the headless browser renders (the child's
 * PNG and the teacher PDF). Two gates now stop it: the quiz validator rejects
 * any colour that is not a known token / var(--token) / #hex, and the engine
 * itself only writes allowlisted colours into a style and escapes the attribute.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const { validate } = require('../../bot/shared/services/quiz/transcript-quiz-validator');
const { renderFigureSvg, unknownColourToken } = require('../../bot/shared/services/quiz/transcript-quiz-figure');
const { Svg } = require('../../bot/vendor/lp-v9/diagrams/lib/svg');

const PAYLOADS = [
  'red"><img src=x onerror=alert(1)>',
  'red"><iframe src=http://127.0.0.1:9/></iframe>',
  'red;background:url(http://127.0.0.1:9/)',
];

const DIGEST = { subject: 'science', slos: [{ id: 'S1', statement: 'پودے کی زندگی کے مراحل ترتیب سے بتانا', taught_level: 'understand' }] };
const W = ['ایک', 'دو', 'تین', 'چار', 'پانچ', 'چھ'];
const flow = (color) => ({
  type: 'flow', direction: 'lr', steps: [
    { title: 'بیج', lines: ['بویا'] }, { title: 'کونپل', lines: ['اگتی ہے'], color }, { title: 'پودا', lines: ['پھول'] }],
});
function q(i, over = {}) {
  return {
    slo_id: 'S1', level: 'understand',
    question: `سوال ${W[i]}: بیج بونے کے بعد پودے کی زندگی کا کون سا مرحلہ آتا ہے؟`,
    options: [`کونپل ${W[i]}`, `پھل ${W[i]}`, `پتے جھڑنا ${W[i]}`], correct_index: 0,
    explanation: 'بیج بونے کے بعد کونپل نکلتی ہے۔',
    distractor_misconceptions: { 1: 'مراحل چھوڑ دیے', 2: 'ترتیب الٹ دی' },
    option_feedback: { correct: 'جی ہاں، پہلے کونپل نکلتی ہے۔', wrong: { 1: 'پھل بہت بعد میں آتا ہے۔', 2: 'پتے آخر میں جھڑتے ہیں۔' } },
    ...over,
  };
}

describe('model colour in an Urdu figure', () => {
  test.each(PAYLOADS)('the validator rejects the colour %s', (payload) => {
    const qs = [0, 1, 2, 3, 4, 5].map((i) => q(i, i === 0 ? { figure: flow(payload) } : {}));
    const r = validate(qs, { language: 'ur', subject: 'science', digest: DIGEST, nExpected: 6 });
    const svg = (r.questions && r.questions[0] && r.questions[0].figureSvg) || '';
    expect(svg).not.toMatch(/<img|<iframe/);
    expect(r.errors.join('\n')).toMatch(/q0: FIGURE_TYPE — unknown colour/);
  });

  test.each(PAYLOADS)('rendered directly, the engine writes no markup from %s', (payload) => {
    const svg = renderFigureSvg(flow(payload), 'ur');
    expect(svg).not.toMatch(/<img|<iframe/);
    expect(svg).not.toMatch(/url\(http/);
    // every style attribute stays one attribute: no raw quote or angle bracket inside
    for (const m of svg.matchAll(/style="([^"]*)"/g)) expect(m[1]).not.toMatch(/[<>]/);
  });

  test('a legal token colour still paints the Urdu label', () => {
    const svg = renderFigureSvg(flow('var(--leaf)'), 'ur');
    expect(svg).toMatch(/color:var\(--leaf\)/);
  });

  test('the engine escapes the style attribute and drops a non-colour fill', () => {
    const s = new Svg(200, 60, { lang: 'ur' });
    s.text(100, 30, 'کونپل', { fill: 'red"><img src=x onerror=alert(1)>', weight: '700"><b>' });
    const out = s.toString();
    expect(out).not.toMatch(/<img|<b>/);
    expect(out).toMatch(/color:var\(--ink, #1A1A1A\)/);
  });
});

describe('unknownColourToken', () => {
  test('accepts the quiz tokens, var(--token[, #hex]) and #hex', () => {
    expect(unknownColourToken({ type: 'pattern', items: [{ shape: 'circle', color: 'warn' }, { shape: 'square', color: 'accent' }] })).toBeNull();
    expect(unknownColourToken({ type: 'flow', steps: [{ title: 'a', color: 'var(--leaf)' }, { title: 'b', color: 'var(--cool, #1B6CA8)' }, { title: 'c', colour: '#abcdef' }] })).toBeNull();
  });
  test('rejects any other colour string, not only unknown var() names', () => {
    expect(unknownColourToken({ type: 'flow', steps: [{ title: 'a', color: 'red"><img src=x>' }] })).toEqual(['red"><img src=x>']);
    expect(unknownColourToken({ type: 'flow', steps: [{ title: 'a', fill: 'url(http://127.0.0.1/)' }] })).toEqual(['url(http://127.0.0.1/)']);
    expect(unknownColourToken({ type: 'flow', steps: [{ title: 'a', color: 'var(--sand)' }] })).toEqual(['var(--sand)']);
  });
});
