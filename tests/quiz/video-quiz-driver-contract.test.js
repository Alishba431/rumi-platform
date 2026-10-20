'use strict';
/**
 * The quiz only calls what every channel driver has.
 *
 * whatsapp.service is a facade over the channel drivers (messaging/index.js), and
 * their shared contract is the static surface of meta-channel.service.js — the
 * Baileys driver derives its own from it, Slack and Discord implement it. A
 * quiz file that calls a method outside it (`sendImageFromBuffer`,
 * `sendVideoWithButtons`) throws "is not a function" the first time that branch
 * runs, and the child's score card or class card simply never arrives.
 *
 * A picture rendered in memory (the score card, the class card) is written to a
 * temporary file and sent with `sendImage(to, absPath, caption)`, which every
 * driver implements, and the file is removed afterwards.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DRIVER = path.join(ROOT, 'bot/shared/services/messaging/meta-channel.service.js');

function driverMethods() {
  const src = fs.readFileSync(DRIVER, 'utf8');
  const out = new Set();
  for (const re of [/^\s*static\s+(?:async\s+)?(\w+)\s*\(/gm, /^\s*static\s+(\w+)\s*=/gm]) {
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
  }
  return out;
}

// Recursive: the lesson-plan and topic providers live one level down.
function quizFiles() {
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(d, e.name);
    if (e.isDirectory()) return walk(rel);
    return e.name.endsWith('.js') ? [rel] : [];
  });
  return ['bot/shared/services/quiz', 'bot/shared/templates'].flatMap(walk);
}

describe('quiz and template files call only the channel-driver contract', () => {
  test('the scan reaches every quiz file, the providers too, and each names the facade WhatsAppService', () => {
    const files = quizFiles();
    expect(files).toEqual(expect.arrayContaining([path.join('bot/shared/services/quiz/providers', 'lp-generated.provider.js')]));
    const otherNames = [];
    for (const rel of files) {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const re = /(?:const|let|var)\s+(\w+)\s*=\s*require\(['"][./]*(?:services\/)?whatsapp\.service['"]\)/g;
      let m;
      while ((m = re.exec(code))) if (m[1] !== 'WhatsAppService') otherNames.push(`${rel}: ${m[1]}`);
    }
    expect(otherNames).toEqual([]);
  });

  test('every WhatsAppService.<method>( names a static of meta-channel.service.js', () => {
    const known = driverMethods();
    expect(known.has('sendImage')).toBe(true);
    const offenders = [];
    for (const rel of quizFiles()) {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const re = /WhatsAppService\.(\w+)\s*\(/g;
      let m;
      while ((m = re.exec(code))) {
        if (!known.has(m[1])) offenders.push(`${rel}: WhatsAppService.${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('a rendered score card goes out as a temp PNG through sendImage', () => {
  beforeEach(() => jest.resetModules());

  test('sendScorecard writes the PNG, sends it with sendImage, then removes the file', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const seen = {};
    jest.doMock('../../bot/shared/services/whatsapp.service', () => ({
      sendImage: jest.fn(async (to, absPath, caption) => {
        seen.exists = fs.existsSync(absPath);
        seen.bytes = seen.exists ? fs.readFileSync(absPath) : null;
        seen.absolute = path.isAbsolute(absPath);
        seen.path = absPath;
        seen.to = to;
        seen.caption = caption;
        return true;
      }),
    }));
    jest.doMock('../../bot/shared/utils/html-to-pdf', () => ({ htmlToImage: jest.fn(async () => png) }));
    jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
      get: jest.fn(async () => null), set: jest.fn(async () => true),
    }));
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    jest.doMock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
    const Scorecard = require('../../bot/shared/services/quiz/video-quiz-scorecard.service');

    const ok = await Scorecard.sendScorecard('15550100001', {
      topic: 'Fractions', correct: 7, total: 8, pct: 88, subject: 'Maths', takerName: 'Child Example', language: 'en',
    });

    expect(ok).toBe(true);
    expect(seen.to).toBe('15550100001');
    expect(seen.absolute).toBe(true);
    expect(seen.exists).toBe(true);
    expect(seen.bytes.equals(png)).toBe(true);
    expect(seen.caption).toMatch(/7/);
    expect(fs.existsSync(seen.path)).toBe(false);
  });
});
