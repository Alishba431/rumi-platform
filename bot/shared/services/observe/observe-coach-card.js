/**
 * The coach-feedback CARD — coach-the-coach feedback as a rendered image.
 *
 * Same visual family as the teacher hero report (navy header, Lexend,
 * embedded fonts, no network at render time), ANCHORED ON A COACHING VALUE:
 * the value the coach's conversation embodied is the card's header, with the
 * wins and the one thing to try beneath it.
 *
 * Trust rules:
 *  - the value is OPTIONAL — a null value gets the neutral title, never an
 *    invented one;
 *  - a HARMFUL debrief never gets a celebration card (the harm gate);
 *  - no score ever appears;
 *  - every model-written string is HTML-escaped.
 *
 * Brand: the deployment's own bot name and the mark shipped in
 * bot/shared/assets — swap those files (or BOT_NAME) to rebrand.
 */

const fs = require('fs');
const path = require('path');
const { isHarmfulDebrief, normalizeCoachValue, COACH_VALUES } = require('./observe-coach-feedback');

// Paths relative to bot/shared. Loaded once per process.
const CARD_ASSET_FILES = {
  logoWhite: 'assets/rumi-mark-white.png',
  logoNavy: 'assets/rumi-mark-navy.png',
  lexR: 'fonts/Lexend-Regular.ttf',
  lexB: 'fonts/Lexend-Bold.ttf',
  nastR: 'fonts/NotoNastaliqUrdu-Regular.ttf',
  nastB: 'fonts/NotoNastaliqUrdu-Bold.ttf',
};

let _assets = null;
function cardAssets() {
  if (_assets) return _assets;
  _assets = {};
  for (const [k, rel] of Object.entries(CARD_ASSET_FILES)) {
    try {
      _assets[k] = fs.readFileSync(path.join(__dirname, '..', '..', rel)).toString('base64');
    } catch (_) {
      _assets[k] = '';
    }
  }
  return _assets;
}

const P = {
  deep: '#0c1a4e',
  shadow: 'rgba(12,26,78,.12)',
  eyebrow: '#9db1e8',
  sub: '#b9c6e6',
  praiseBg: '#f4f6fb',
  praiseText: '#1c2749',
  sec: '#8b97b8',
  winTitle: '#123a8a',
  winQuote: '#3f4c6e',
  lock: '#67729b',
};

/** Celebration cards are for coaching worth celebrating — never for harm. */
function shouldRenderCard(fb) {
  return !isHarmfulDebrief(fb && fb.rubric);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _isRtl(lang) {
  try {
    const { supportedLanguages } = require('../../config/branding');
    const hit = (supportedLanguages || []).find((l) => l.code === lang);
    return !!(hit && hit.direction === 'rtl');
  } catch (_) {
    return false;
  }
}

function buildCoachCardHtml(fb, { lang = 'en' } = {}) {
  const { observeStrings } = require('./observe-strings');
  const { botName } = require('../../config/branding');
  const S = observeStrings(lang);
  const A = cardAssets();
  const rtl = _isRtl(lang);
  const valueKey = normalizeCoachValue(fb.value);
  const header = valueKey ? (S[`coach_value_${valueKey}`] || COACH_VALUES[valueKey]) : S.coach_card_title;
  const eyebrow = valueKey ? S.coach_card_value_eyebrow : S.coach_card_eyebrow;
  const t = fb.try || {};

  const wins = (fb.wins || []).map((w) => `
      <div class="win">
        <div class="tick">✓</div>
        <div>
          <div class="wt">${esc(w.behaviour)}</div>
          <div class="wq">“${esc(w.evidence)}”</div>
        </div>
      </div>`).join('');

  // Lexend for Latin; the Nastaliq face stays in the stack as a fallback so a
  // card whose prose came back in a right-to-left script never prints as
  // empty boxes. Flex layout only — nothing absolutely positioned — so the
  // same markup is RTL-safe.
  const rtlFont = rtl ? "'NastaliqUrdu'," : '';
  return `<!doctype html><html${rtl ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><style>
@font-face{font-family:'Lexend';font-weight:400;src:url(data:font/ttf;base64,${A.lexR})}
@font-face{font-family:'Lexend';font-weight:700;src:url(data:font/ttf;base64,${A.lexB})}
@font-face{font-family:'NastaliqUrdu';font-weight:400;src:url(data:font/ttf;base64,${A.nastR})}
@font-face{font-family:'NastaliqUrdu';font-weight:700;src:url(data:font/ttf;base64,${A.nastB})}
*{margin:0;padding:0;box-sizing:border-box;font-family:${rtlFont}'Lexend','NastaliqUrdu','Segoe UI',-apple-system,sans-serif}
.card{width:760px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 1px 3px ${P.shadow}}
.hd{background:${P.deep};color:#fff;padding:30px 38px 28px}
.hd .top{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.hd .top img{width:64px;height:auto;display:block}
.hd .eb{font-size:13px;letter-spacing:${rtl ? '0' : '.16em'};${rtl ? '' : 'text-transform:uppercase;'}color:${P.eyebrow};font-weight:700;line-height:1.8}
.hd h1{font-size:${rtl ? '36px' : '44px'};font-weight:700;line-height:${rtl ? '2' : '1.6'}}
.hd .sub{font-size:16px;color:${P.sub};margin-top:6px;line-height:${rtl ? '2.3' : '1.9'}}
.bd{padding:26px 38px 6px}
.praise{background:${P.praiseBg};border-${rtl ? 'right' : 'left'}:4px solid #f2a65a;border-radius:10px;padding:16px 20px;font-size:17px;line-height:${rtl ? '2.4' : '2'};color:${P.praiseText}}
.sec{font-size:13px;color:${P.sec};font-weight:700;margin:26px 0 14px;letter-spacing:${rtl ? '0' : '.14em'};${rtl ? '' : 'text-transform:uppercase;'}}
.win{display:flex;gap:14px;margin-bottom:18px;align-items:flex-start}
.win .tick{flex:none;width:28px;height:28px;border-radius:50%;background:#e7f3ec;color:#1d7a46;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:15px;margin-top:4px}
.win .wt{font-size:17px;font-weight:700;color:${P.winTitle};line-height:${rtl ? '2.2' : '1.9'}}
.win .wq{font-size:15px;color:${P.winQuote};margin-top:6px;line-height:${rtl ? '2.4' : '2'};background:#fafbfd;border-radius:8px;padding:10px 14px}
.try{background:#eef7f0;border-radius:14px;padding:20px 22px;margin:8px 0 16px}
.try .tl{font-size:13px;color:#1d7a46;font-weight:700;letter-spacing:${rtl ? '0' : '.14em'};${rtl ? '' : 'text-transform:uppercase;'}}
.try h2{font-size:${rtl ? '19px' : '22px'};color:#14532d;font-weight:700;margin:8px 0 6px;line-height:${rtl ? '2.3' : '1.9'}}
.try p{font-size:15px;color:#2f4a3a;line-height:${rtl ? '2.4' : '2'};margin-top:6px}
.act{background:#f6f8fb;border-radius:14px;padding:16px 22px;margin:6px 0 16px}
.act p{font-size:15px;color:#2a3b4d;line-height:${rtl ? '2.4' : '2'}}
.ask{border-${rtl ? 'right' : 'left'}:4px solid #F5B301;padding:10px 16px;margin:6px 0 20px}
.ask p{font-size:15px;color:#4a4436;font-style:italic;line-height:${rtl ? '2.4' : '2'}}
.ft{border-top:1px solid #e7ebf4;padding:16px 38px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.ft .brand{display:flex;align-items:center;gap:9px}
.ft .brand img{width:30px;height:auto}
.ft .brand span{font-weight:700;color:${P.deep};font-size:16px;font-family:'Lexend',sans-serif}
.ft .lock{font-size:14px;color:${P.lock};line-height:${rtl ? '2.2' : '1.9'}}
</style></head><body><div class="card">
  <div class="hd">
    <div class="top">
      <img src="data:image/png;base64,${A.logoWhite}" alt=""/>
      <div class="eb">${esc(eyebrow)}</div>
    </div>
    <h1>${esc(header)}</h1>
    <div class="sub">${esc(S.coach_card_subtitle)}</div>
  </div>
  <div class="bd">
    <div class="praise">${esc(fb.praise_line || '')}</div>
    <div class="sec">${esc(S.coach_card_wins_label)}</div>
    ${wins}
    <div class="try">
      <div class="tl">${esc(S.coach_card_try_label)}</div>
      <h2>${esc(t.move || '')}</h2>
      <p>${esc(t.evidence || '')}</p>
    </div>
    ${t.instead ? `<div class="sec">${esc(S.coach_card_action_label)}</div>
    <div class="act"><p>${esc(t.instead)}</p></div>` : ''}
    ${fb.reflection_question ? `<div class="sec">${esc(S.coach_card_reflect_label)}</div>
    <div class="ask"><p>${esc(fb.reflection_question)}</p></div>` : ''}
  </div>
  <div class="ft">
    <div class="brand"><img src="data:image/png;base64,${A.logoNavy}" alt=""/><span>${esc(botName)}</span></div>
    <span class="lock">🔒 ${esc(S.coach_card_closing)}</span>
  </div>
</div></body></html>`;
}

/**
 * Render the card PNG. Returns null (never throws) when the card should not or
 * cannot be rendered — the caller falls back to the text card, so a browser
 * hiccup can never cost a coach their feedback.
 * @returns {Promise<Buffer|null>}
 */
async function renderCoachCard(fb, { lang = 'en' } = {}) {
  if (!shouldRenderCard(fb)) return null;
  try {
    const { htmlToImage } = require('../../utils/html-to-pdf');
    const html = buildCoachCardHtml(fb, { lang });
    return await htmlToImage(html, { selector: '.card', width: 800, deviceScaleFactor: 2 });
  } catch (err) {
    const { logToFile } = require('../../utils/logger');
    logToFile('⚠️ coach card render failed — falling back to the text card', { error: err.message });
    return null;
  }
}

module.exports = { CARD_ASSET_FILES, shouldRenderCard, buildCoachCardHtml, renderCoachCard };
