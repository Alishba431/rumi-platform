'use strict';
/**
 * html-to-pdf's untrusted mode, in the real Chromium, against a real local
 * listener. The unit test (html-to-pdf-untrusted.test.js) pins the options;
 * this one proves what they are for: a page holding a prefetch, an iframe, an
 * object, an img and a css url() that point at 127.0.0.1 makes the server's
 * browser open NO connection to it, for the card PNG and for the PDF.
 *
 * Each vector gets its own TCP listener, so a bare connect (a preconnect, an
 * iframe frame that never sends a request line) counts as a hit too.
 *
 * It needs the browser the bot's postinstall downloads; a checkout installed
 * without it (the postinstall's documented opt-out) skips, saying so.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

function hasChromium() {
  try {
    // playwright-core is a bot dependency: resolve it the way html-to-pdf does.
    const bot = path.join(__dirname, '../../bot');
    const { chromium } = require(require.resolve('playwright-core', { paths: [bot] }));
    return fs.existsSync(chromium.executablePath());
  } catch { return false; }
}
const RUN = hasChromium();
if (!RUN) {
  // eslint-disable-next-line no-console
  console.warn('html-to-pdf-untrusted-network: no Chromium installed for playwright-core — skipped');
}

const VECTORS = ['prefetch', 'preconnect', 'iframe', 'object', 'img', 'css'];

async function listeners() {
  const hits = {};
  const servers = {};
  await Promise.all(VECTORS.map((v) => new Promise((resolve) => {
    hits[v] = 0;
    servers[v] = net.createServer((sock) => {
      hits[v] += 1;
      sock.on('error', () => {});
      sock.on('data', () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    });
    servers[v].listen(0, '127.0.0.1', resolve);
  })));
  const url = (v) => `http://127.0.0.1:${servers[v].address().port}/${v}`;
  const close = () => Promise.all(Object.values(servers).map((s) => new Promise((r) => s.close(r))));
  return { hits, url, close };
}

function page(url) {
  return `<!doctype html><html><head>
<link rel="prefetch" href="${url('prefetch')}"><link rel="preconnect" href="${url('preconnect')}">
<style>.card{width:200px;height:80px;background:url(${url('css')})}</style>
</head><body><div class="card">card<img src="${url('img')}">
<iframe src="${url('iframe')}"></iframe><object data="${url('object')}"></object></div></body></html>`;
}

const maybe = RUN ? describe : describe.skip;

maybe('untrusted render in real Chromium', () => {
  jest.setTimeout(60000);
  let H;
  beforeAll(() => { H = require('../../bot/shared/utils/html-to-pdf'); });
  afterAll(async () => { if (H) await H.closeBrowser(); });

  it.each([
    ['htmlToImage', (html) => H.htmlToImage(html, { width: 400, deviceScaleFactor: 1, selector: '.card', untrusted: true })],
    ['htmlToPdf', (html) => H.htmlToPdf(html, { untrusted: true })],
  ])('%s opens no connection to a local listener', async (name, render) => {
    const L = await listeners();
    try {
      const buf = await render(page(L.url));
      expect(buf.length).toBeGreaterThan(0);
      // Prefetch and frames are fire-and-forget: give them time to arrive.
      await new Promise((r) => setTimeout(r, 1500));
      expect(L.hits).toEqual(Object.fromEntries(VECTORS.map((v) => [v, 0])));
    } finally {
      await L.close();
    }
  });

  it('the same page in a default render does reach the listener (the probe works)', async () => {
    const L = await listeners();
    try {
      await H.htmlToImage(page(L.url), { width: 400, deviceScaleFactor: 1, selector: '.card' });
      await new Promise((r) => setTimeout(r, 1500));
      expect(Object.values(L.hits).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    } finally {
      await L.close();
    }
  });
});
