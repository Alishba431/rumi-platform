/**
 * matrix-outbound-relay.js -- what the relay owner (the bot) must refuse.
 *
 * Anyone who can LPUSH to the shared Redis can put a request in the owner's
 * list. The owner must therefore (1) never read a local path a request names
 * -- files cross only as bytes the caller encoded, media only as http(s) URLs
 * or those bytes; (2) run only requests signed with the key both processes
 * derive from MATRIX_ACCESS_TOKEN, and only before the caller's deadline;
 * (3) listen only on its own deployment's namespace.
 *
 * The real relay module runs on both sides; Redis is an in-memory fake at the
 * network boundary (lpush / brpop / expire, shared by every "connection"),
 * which also records which keys each side used.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeRedisServer() {
  const lists = new Map();
  const popped = new Set();
  const pushed = [];
  class FakeRedis {
    constructor() { this.closed = false; }

    async lpush(key, value) {
      pushed.push({ key, value });
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key).unshift(value);
      return lists.get(key).length;
    }

    async brpop(key, timeoutSeconds) {
      popped.add(key);
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (!this.closed) {
        const list = lists.get(key);
        if (list && list.length) return [key, list.pop()];
        if (Date.now() >= deadline) return null;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return null;
    }

    async expire() { return 1; }

    disconnect() { this.closed = true; }
  }
  return { FakeRedis, lists, popped, pushed };
}

const DEPLOYMENT_A = { MATRIX_ACCESS_TOKEN: 'syt_test_token_deployment_a', MATRIX_HOMESERVER_URL: 'https://matrix.example.org' };
const DEPLOYMENT_B = { MATRIX_ACCESS_TOKEN: 'syt_test_token_deployment_b', MATRIX_HOMESERVER_URL: 'https://staging.example.org' };
const ENV_KEYS = ['REDIS_URL', 'MATRIX_ACCESS_TOKEN', 'MATRIX_HOMESERVER_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let relay;
let server;

function useDeployment(deployment) {
  Object.assign(process.env, deployment);
}

function loadRelay(deployment = DEPLOYMENT_A) {
  jest.resetModules();
  server = fakeRedisServer();
  jest.doMock('ioredis', () => server.FakeRedis);
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  process.env.REDIS_URL = 'redis://fake:6379';
  useDeployment(deployment);
  // eslint-disable-next-line global-require
  relay = require('../../bot/shared/services/messaging/matrix-outbound-relay');
  return relay;
}

afterEach(() => {
  if (relay) relay._resetForTests();
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  jest.resetModules();
});

const TO = 'mtx:15550100101';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The documented signing scheme, re-implemented here so the test pins it (a
// worker and a bot on different releases must still agree on it).
function signingKey(token) {
  return Buffer.from(crypto.hkdfSync('sha256', token, Buffer.alloc(0), 'rumi-matrix-relay/v1/signing-key', 32));
}
function sign(request, token = DEPLOYMENT_A.MATRIX_ACCESS_TOKEN) {
  const sig = crypto.createHmac('sha256', signingKey(token)).update(JSON.stringify(request)).digest('hex');
  return JSON.stringify({ ...request, sig });
}
function freshRequest(method, args, extra = {}) {
  const now = Date.now();
  return { v: 1, id: crypto.randomUUID(), method, args, issuedAt: now, expiresAt: now + 60000, ...extra };
}

/** The request list the running owner actually listens on, read off the wire. */
async function ownerListKey() {
  for (let i = 0; i < 100; i += 1) {
    const key = [...server.popped].find((k) => !/reply/.test(k));
    if (key) return key;
    // eslint-disable-next-line no-await-in-loop
    await sleep(5);
  }
  throw new Error('the owner never started listening');
}

async function replyFor(id, waitMs = 1000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const hit = server.pushed.find((p) => p.key.endsWith(`:${id}`));
    if (hit) return { key: hit.key, reply: JSON.parse(hit.value) };
    // eslint-disable-next-line no-await-in-loop
    await sleep(5);
  }
  return null;
}

function wireText() {
  return server.pushed.map((p) => p.value).join('\n');
}

/** A file only the bot's container has, e.g. its .env -- must never leave it. */
function writeOwnerSecret() {
  const file = path.join(os.tmpdir(), `relay-owner-secret-${process.pid}-${Date.now()}.env`);
  const canary = `SERVICE_ROLE_KEY=canary-${crypto.randomUUID()}`;
  fs.writeFileSync(file, canary);
  return { file, canary };
}

function readingImpls() {
  // Each fake driver method reads what it is handed, like the real driver does.
  const read = (value) => fs.readFileSync(String(value).replace(/^file:\/\//, ''), 'utf8');
  const seen = [];
  const impl = (name) => jest.fn(async (to, ref) => { seen.push({ name, bytes: read(ref) }); return true; });
  const names = ['sendDocument', 'sendImage', 'sendSticker', 'sendDocumentFromUrl', 'sendImageFromUrl', 'sendVideoFromUrl',
    'sendAudioFromUrl', 'sendAudioFromUrlReturningId', 'sendImageWithButtons'];
  return { impls: Object.fromEntries(names.map((n) => [n, impl(n)])), seen };
}

describe('the owner never reads a local path a request names', () => {
  it('an unsigned, forged sendDocument naming a bot-local file reads nothing and sends nothing', async () => {
    loadRelay();
    const { file, canary } = writeOwnerSecret();
    const { impls, seen } = readingImpls();
    try {
      relay.startOwner(impls);
      const list = await ownerListKey();
      await new server.FakeRedis().lpush(list, JSON.stringify({
        id: 'forged', method: 'sendDocument', args: [TO, file, 'notes.txt', 'hi'], expiresAt: Date.now() + 60000,
      }));
      await sleep(150);
      expect(seen).toEqual([]);
      expect(impls.sendDocument).not.toHaveBeenCalled();
      expect(wireText()).not.toContain(canary);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  const cases = [
    ['sendDocument', 'an absolute path', (f) => [TO, f, 'notes.txt', 'hi']],
    ['sendImage', 'a relative path', (f) => [TO, path.relative(process.cwd(), f), 'look']],
    ['sendSticker', 'an absolute path', (f) => [TO, f]],
    ['sendDocumentFromUrl', 'a file:// URL', (f) => [TO, `file://${f}`, 'notes.txt', 'hi']],
    ['sendImageFromUrl', 'a bare path', (f) => [TO, f, 'look']],
    ['sendVideoFromUrl', 'a relative path', (f) => [TO, path.relative(process.cwd(), f)]],
    ['sendAudioFromUrl', 'a file:// URL', (f) => [TO, `file://${f}`]],
    ['sendImageWithButtons', 'a file:// URL', (f) => [TO, `file://${f}`, 'pick', [{ id: '1', title: 'One' }]]],
    ['sendDocument', 'a __rumiFile that names a path instead of carrying bytes', (f) => [TO, { __rumiFile: { name: 'x.txt', path: f } }, 'x.txt', '']],
  ];

  it.each(cases)('even correctly signed, %s with %s is refused: a failure reply, nothing read, nothing sent', async (method, _shape, argsFor) => {
    loadRelay();
    const { file, canary } = writeOwnerSecret();
    const { impls, seen } = readingImpls();
    const readFileSync = jest.spyOn(fs, 'readFileSync');
    try {
      relay.startOwner(impls);
      const list = await ownerListKey();
      const request = freshRequest(method, argsFor(file));
      await new server.FakeRedis().lpush(list, sign(request));

      const answered = await replyFor(request.id);
      expect(answered && answered.reply.ok).toBe(false);
      expect(impls[method]).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      expect(readFileSync.mock.calls.filter(([p]) => String(p).includes(path.basename(file)))).toEqual([]);
      expect(wireText()).not.toContain(canary);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('a __rumiFile name cannot steer where the bytes land on the owner', async () => {
    loadRelay();
    let landed = null;
    relay.startOwner({ sendDocument: jest.fn(async (to, p) => { landed = { p, bytes: fs.readFileSync(p, 'utf8') }; return true; }) });
    const list = await ownerListKey();
    const request = freshRequest('sendDocument', [TO, { __rumiFile: { name: '..', data: Buffer.from('pdf').toString('base64') } }, 'a.pdf', '']);
    await new server.FakeRedis().lpush(list, sign(request));
    const answered = await replyFor(request.id);
    expect(answered.reply.ok).toBe(true);
    expect(landed.bytes).toBe('pdf');
    expect(path.dirname(landed.p).startsWith(path.join(os.tmpdir(), 'rumi-matrix-relay-'))).toBe(true);
  });

  it('every driver method that reads a file or a media URL has its argument shapes declared to the relay', () => {
    loadRelay();
    jest.doMock('../../bot/shared/services/messaging/matrix-connection', () => ({ getClient: jest.fn(), isE2eeActive: () => true }));
    jest.doMock('../../bot/shared/storage/r2', () => ({ downloadFromR2: jest.fn(), extractKeyFromUrl: jest.fn() }));
    // eslint-disable-next-line global-require
    const driver = require('../../bot/shared/services/messaging/matrix-channel.service');
    const readers = Object.entries(driver._localImplementations)
      .filter(([, fn]) => /fs\.readFileSync|fs\.existsSync|resolveMediaBuffer\(/.test(fn.toString()))
      .map(([name]) => name);
    expect(readers.length).toBeGreaterThan(5);
    for (const name of readers) expect([name, relay._ARG_KINDS[name] !== undefined]).toEqual([name, true]);
  });
});

describe('the owner runs only signed, current requests', () => {
  it('an unsigned request is not executed', async () => {
    loadRelay();
    const sendMessage = jest.fn(async () => true);
    relay.startOwner({ sendMessage });
    const list = await ownerListKey();
    await new server.FakeRedis().lpush(list, JSON.stringify(freshRequest('sendMessage', [TO, 'from anyone with Redis'])));
    await sleep(150);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a request whose signature does not match its body (tampered recipient) is not executed', async () => {
    loadRelay();
    const sendMessage = jest.fn(async () => true);
    relay.startOwner({ sendMessage });
    const list = await ownerListKey();
    const signed = JSON.parse(sign(freshRequest('sendMessage', [TO, 'Your lesson plan'])));
    signed.args[0] = 'mtx:15550199999';
    await new server.FakeRedis().lpush(list, JSON.stringify(signed));
    await sleep(150);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a request signed with another deployment\'s key is not executed', async () => {
    loadRelay();
    const sendMessage = jest.fn(async () => true);
    relay.startOwner({ sendMessage });
    const list = await ownerListKey();
    await new server.FakeRedis().lpush(list, sign(freshRequest('sendMessage', [TO, 'hi']), DEPLOYMENT_B.MATRIX_ACCESS_TOKEN));
    await sleep(150);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a signed request past its caller\'s deadline, or with no deadline, is skipped', async () => {
    loadRelay();
    const sendMessage = jest.fn(async () => true);
    relay.startOwner({ sendMessage });
    const list = await ownerListKey();
    const now = Date.now();
    await new server.FakeRedis().lpush(list, sign(freshRequest('sendMessage', [TO, 'late'], { issuedAt: now - 5000, expiresAt: now - 1000 })));
    const noDeadline = freshRequest('sendMessage', [TO, 'whenever']);
    delete noDeadline.expiresAt;
    await new server.FakeRedis().lpush(list, sign(noDeadline));
    await sleep(150);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('the same signed request replayed is executed once', async () => {
    loadRelay();
    const sendMessage = jest.fn(async () => true);
    relay.startOwner({ sendMessage });
    const list = await ownerListKey();
    const wire = sign(freshRequest('sendMessage', [TO, 'once']));
    await new server.FakeRedis().lpush(list, wire);
    await sleep(80);
    await new server.FakeRedis().lpush(list, wire);
    await sleep(150);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('the caller does not believe a forged reply', async () => {
    loadRelay();
    relay._setTimeoutForTests(400);
    const pending = relay.call('sendMessage', [TO, 'hi']); // no owner running
    let request = null;
    for (let i = 0; i < 100 && !request; i += 1) {
      const hit = server.pushed.find((p) => !/reply/.test(p.key));
      if (hit) request = { key: hit.key, body: JSON.parse(hit.value) };
      // eslint-disable-next-line no-await-in-loop
      if (!request) await sleep(5);
    }
    let replyKey = null;
    for (let i = 0; i < 100 && !replyKey; i += 1) {
      replyKey = [...server.popped].find((k) => k.endsWith(`:${request.body.id}`));
      // eslint-disable-next-line no-await-in-loop
      if (!replyKey) await sleep(5);
    }
    await new server.FakeRedis().lpush(replyKey, JSON.stringify({ id: request.body.id, ok: true, result: true }));
    await expect(pending).resolves.toBe(false);
  });
});

describe('two deployments sharing one Redis', () => {
  it('a worker of deployment A is never served by the bot of deployment B', async () => {
    loadRelay(DEPLOYMENT_B);
    const sendMessageB = jest.fn(async () => true);
    relay.startOwner({ sendMessage: sendMessageB });
    const listB = await ownerListKey();

    useDeployment(DEPLOYMENT_A); // this process now acts as A's worker
    relay._setTimeoutForTests(300);
    await expect(relay.call('sendMessage', [TO, 'for A only'])).resolves.toBe(false);
    expect(sendMessageB).not.toHaveBeenCalled();
    const listA = server.pushed.find((p) => !/reply/.test(p.key)).key;
    expect(listA).not.toBe(listB);
    expect([listA, listB]).not.toContain('rumi:matrix:relay:requests');
  });

  it('the namespace is stable (same token + homeserver, same lists) and replies use it too', async () => {
    loadRelay();
    relay.startOwner({ sendMessage: jest.fn(async () => true) });
    const list = await ownerListKey();
    await expect(relay.call('sendMessage', [TO, 'hi'])).resolves.toBe(true);
    const namespace = list.replace(/requests$/, '');
    expect(namespace).not.toBe('rumi:matrix:relay:');
    const replyKeys = server.pushed.map((p) => p.key).filter((k) => k !== list);
    expect(replyKeys.length).toBe(1);
    expect(replyKeys[0].startsWith(namespace)).toBe(true);

    const first = list;
    relay._resetForTests();
    loadRelay();
    relay.startOwner({});
    expect(await ownerListKey()).toBe(first);
  });
});

describe('a file the WORKER generated still arrives with its bytes', () => {
  it('sendDocument, sendImage and sendAudio round-trip through the caller\'s encoder', async () => {
    loadRelay();
    const got = {};
    relay.startOwner({
      sendDocument: jest.fn(async (to, p, filename) => { got.doc = { bytes: fs.readFileSync(p, 'utf8'), filename }; return true; }),
      sendImage: jest.fn(async (to, p, caption) => { got.img = { bytes: fs.readFileSync(p, 'utf8'), ext: path.extname(p), caption }; return true; }),
      sendAudio: jest.fn(async (to, buffer, tempDir) => { got.audio = { bytes: buffer.toString(), tempDir }; return true; }),
    });
    const pdf = path.join(os.tmpdir(), `relay-worker-${process.pid}-${Date.now()}.pdf`);
    const png = path.join(os.tmpdir(), `relay-worker-${process.pid}-${Date.now()}.png`);
    fs.writeFileSync(pdf, '%PDF-1.4 lesson plan');
    fs.writeFileSync(png, 'PNG chart');
    try {
      await expect(relay.call('sendDocument', [TO, pdf, 'lesson_plan.pdf', 'Your plan'])).resolves.toBe(true);
      await expect(relay.call('sendImage', [TO, png, 'Your chart'])).resolves.toBe(true);
      await expect(relay.call('sendAudio', [TO, Buffer.from('tts-mp3'), os.tmpdir()])).resolves.toBe(true);
      expect(got.doc).toEqual({ bytes: '%PDF-1.4 lesson plan', filename: 'lesson_plan.pdf' });
      expect(got.img).toEqual({ bytes: 'PNG chart', ext: '.png', caption: 'Your chart' });
      expect(got.audio.bytes).toBe('tts-mp3');
      expect(got.audio.tempDir == null).toBe(true); // a worker-local dir means nothing on the owner
      // No worker-local path ever goes on the wire.
      expect(wireText()).not.toContain(pdf);
      expect(wireText()).not.toContain(png);
    } finally {
      fs.rmSync(pdf, { force: true });
      fs.rmSync(png, { force: true });
    }
  });
});
