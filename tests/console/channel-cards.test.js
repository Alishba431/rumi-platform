/**
 * Additive channels on the console: each one gets its own card with its own
 * name and setup pointer, and its own plain-language "what happens if I turn
 * this off" line. The card used to be a two-way slack/discord ternary, so a
 * third channel rendered as a second "Discord" card with Discord's link.
 */

const { buildCatalog } = require('../../bot/console/env-catalog');
const { WHEN_OFF } = require('../../bot/console/features');
const { FEATURES, ADDITIVE_CHANNEL_REQUIRED_VARS } = require('../../bot/shared/config/feature-availability');

function channelCards(env) {
  const group = buildCatalog(env).groups.find((g) => g.id === 'channels');
  return group ? group.abilities.filter((a) => a.guide) : [];
}

describe('console channel cards', () => {
  it('gives every additive channel a card titled with its own name', () => {
    const cards = channelCards({});
    const titles = cards.map((c) => c.title);
    expect(titles).toEqual(expect.arrayContaining(['Slack', 'Discord', 'Matrix']));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('points the Matrix card at a homeserver, not at Discord', () => {
    const matrix = channelCards({}).find((c) => c.guide === 'matrix');
    expect(matrix.title).toBe('Matrix');
    expect(matrix.keys).toEqual(ADDITIVE_CHANNEL_REQUIRED_VARS.matrix);
    expect(matrix.why).toMatch(/Matrix/);
    expect(matrix.where).not.toMatch(/discord/i);
  });

  it('has a "when off" line for every channel feature', () => {
    const channelIds = FEATURES.map((f) => f.id).filter((id) => id && id.startsWith('channel_'));
    expect(channelIds).toEqual(expect.arrayContaining(['channel_slack', 'channel_discord', 'channel_matrix']));
    for (const id of channelIds) expect(WHEN_OFF[id]).toEqual(expect.any(String));
  });
});

// The extra channels can be the only channels (CHANNEL_DRIVER=none), so no
// copy about them may promise that WhatsApp is there too.
describe('channel copy does not assume WhatsApp exists', () => {
  const ASSUMES_WHATSAPP = /as well as WhatsApp|WhatsApp is unaffected|alongside (?:your )?WhatsApp/i;

  it('on the console cards, the group blurb and the "when off" lines', () => {
    const catalog = buildCatalog({ CHANNEL_DRIVER: 'none' });
    const group = catalog.groups.find((g) => g.id === 'channels');
    expect(group.blurb).not.toMatch(ASSUMES_WHATSAPP);
    for (const card of channelCards({ CHANNEL_DRIVER: 'none' })) expect(card.why).not.toMatch(ASSUMES_WHATSAPP);
    for (const [id, text] of Object.entries(WHEN_OFF)) {
      if (id.startsWith('channel_')) expect(text).not.toMatch(ASSUMES_WHATSAPP);
    }
  });

  it('in the doctor notes and the .env.template channel headers', () => {
    for (const f of FEATURES.filter((x) => x.id && x.id.startsWith('channel_'))) {
      expect(f.notes || '').not.toMatch(ASSUMES_WHATSAPP);
    }
    const template = require('fs').readFileSync(require('path').join(__dirname, '../../.env.template'), 'utf8');
    const headers = template.split('\n').filter((l) => /^# --- ENABLES: (?:Slack|Discord|Matrix) channel/.test(l));
    expect(headers).toHaveLength(3);
    for (const line of headers) expect(line).not.toMatch(ASSUMES_WHATSAPP);
  });
});

describe('console overview: what Rumi is answering on', () => {
  const { answeringOn } = require('../../bot/console/env-catalog');

  it('names the messenger on a WhatsApp-free deployment', () => {
    expect(answeringOn('none', ['matrix'])).toBe('Answering on Rumi Messenger (Matrix) — no WhatsApp number.');
    expect(answeringOn('none', ['matrix', 'slack'])).toBe('Answering on Rumi Messenger (Matrix) and Slack — no WhatsApp number.');
  });

  it('says plainly when nothing can answer', () => {
    expect(answeringOn('none', [])).toMatch(/No channel is configured/);
  });

  it('keeps the WhatsApp wording, plus any extra channels', () => {
    expect(answeringOn('meta', [])).toBe('Answering on an official WhatsApp Business number.');
    expect(answeringOn('meta', ['matrix'])).toBe('Answering on an official WhatsApp Business number, and on Rumi Messenger (Matrix).');
    expect(answeringOn('baileys', [])).toMatch(/linked WhatsApp account/);
  });
});
