/**
 * The coach-the-coach CARD — the feedback rendered as an image, anchored on
 * the coaching value the coach's conversation embodied.
 *
 * Trust rules: a harmful debrief never gets a celebration card; no score ever
 * appears; every model-written string is HTML-escaped; a null value gets the
 * neutral title, never an invented one; a render failure returns null so the
 * caller falls back to the text card. The card carries THIS deployment's
 * brand (bot name + the shipped mark), no partner logo.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const mockHtmlToImage = jest.fn(async () => Buffer.from('PNG'));
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({ htmlToImage: (...a) => mockHtmlToImage(...a) }));

const fs = require('fs');
const path = require('path');
const {
  buildCoachCardHtml,
  renderCoachCard,
  shouldRenderCard,
  CARD_ASSET_FILES,
} = require('../../bot/shared/services/observe/observe-coach-card');
const { observeStrings } = require('../../bot/shared/services/observe/observe-strings');

const S = observeStrings('en');

const rubric = (over = {}) => ({
  opened_with_specific_praise: true, anchored_in_real_moment: true, asked_and_waited: true,
  one_improvement_only: true, moves_not_teacher: true, elicited_if_then: true,
  righting_reflex_held: true, disparaged_teacher: false, ...over,
});

const fb = (over = {}) => ({
  praise_line: 'You opened by naming a real strength.',
  wins: [
    { behaviour: 'Praise with evidence', evidence: 'I liked the <b>counting sticks</b>.' },
    { behaviour: 'Their own plan', evidence: 'What will you try on Monday?' },
  ],
  try: { move: 'Hold the silence', evidence: 'You answered your own question.', instead: 'Count to five first.' },
  reflection_question: 'What does a silence give the teacher?',
  value: 'listening',
  rubric: rubric(),
  ...over,
});

describe('buildCoachCardHtml', () => {
  test('the value is the header; wins, try, action plan and question are all there', () => {
    const html = buildCoachCardHtml(fb(), { lang: 'en' });
    expect(html).toContain('<h1>Listening</h1>');
    expect(html).toContain(S.coach_card_value_eyebrow);
    expect(html).toContain('Praise with evidence');
    expect(html).toContain('Hold the silence');
    expect(html).toContain('Count to five first.');
    expect(html).toContain('What does a silence give the teacher?');
  });

  test('a null value gets the neutral title, never an invented one', () => {
    const html = buildCoachCardHtml(fb({ value: null }), { lang: 'en' });
    expect(html).toContain(`<h1>${S.coach_card_title}</h1>`);
    expect(html).toContain(S.coach_card_eyebrow);
  });

  test('model output is escaped', () => {
    const html = buildCoachCardHtml(fb(), { lang: 'en' });
    expect(html).toContain('&lt;b&gt;counting sticks&lt;/b&gt;');
    expect(html).not.toContain('<b>counting sticks</b>');
  });

  test('carries the deployment brand, never a partner mark', () => {
    const html = buildCoachCardHtml(fb(), { lang: 'en' });
    const { botName } = require('../../bot/shared/config/branding');
    expect(html).toContain(`<span>${botName}</span>`);
    // The marks are the ones this repository ships, and every asset exists.
    expect([CARD_ASSET_FILES.logoWhite, CARD_ASSET_FILES.logoNavy]).toEqual(['assets/rumi-mark-white.png', 'assets/rumi-mark-navy.png']);
    for (const f of Object.values(CARD_ASSET_FILES)) {
      expect(fs.existsSync(path.join(__dirname, '../../bot/shared', f))).toBe(true);
    }
  });

  test('no score on the card', () => {
    const html = buildCoachCardHtml(fb(), { lang: 'en' });
    const text = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/base64,[A-Za-z0-9+/=]+/g, '');
    expect(text).not.toMatch(/\d+\s*\/\s*\d+\b(?![a-z])/);
  });
});

describe('renderCoachCard', () => {
  beforeEach(() => mockHtmlToImage.mockClear());

  test('renders a PNG via htmlToImage', async () => {
    const png = await renderCoachCard(fb(), { lang: 'en' });
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(mockHtmlToImage).toHaveBeenCalledWith(expect.stringContaining('class="card"'), expect.objectContaining({ selector: '.card' }));
  });

  test('a harmful debrief never gets a celebration card', async () => {
    expect(shouldRenderCard(fb({ rubric: rubric({ disparaged_teacher: true }) }))).toBe(false);
    expect(await renderCoachCard(fb({ rubric: rubric({ moves_not_teacher: false }) }), { lang: 'en' })).toBeNull();
    expect(mockHtmlToImage).not.toHaveBeenCalled();
  });

  test('a render failure returns null (the caller falls back to text)', async () => {
    mockHtmlToImage.mockRejectedValueOnce(new Error('no browser'));
    expect(await renderCoachCard(fb(), { lang: 'en' })).toBeNull();
  });
});
