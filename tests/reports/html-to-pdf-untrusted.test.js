/**
 * html-to-pdf `untrusted` mode. A page built from model or child text (the
 * lesson-quiz figures, cards, teacher PDF and class report) needs neither
 * JavaScript nor the network: its fonts and images are data: URIs. In that
 * mode the context runs no page script and every request other than data: /
 * about: is aborted, so markup that slipped past escaping can neither run nor
 * fetch an internal URL. Other callers keep the old context exactly.
 * playwright-core is mocked as in html-to-pdf.test.js (no real Chromium).
 */

const path = require('path');

let launchMock, page, context, browser;

const PLAYWRIGHT = (() => {
  try {
    return require.resolve('playwright-core', { paths: [path.join(__dirname, '../../bot/shared/utils')] });
  } catch {
    return null;
  }
})();

function load() {
  jest.resetModules();
  page = {
    setContent: jest.fn().mockResolvedValue(),
    evaluate: jest.fn().mockResolvedValue(),
    pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
    $: jest.fn().mockResolvedValue(null),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('PNGfake')),
  };
  context = {
    newPage: jest.fn().mockResolvedValue(page),
    close: jest.fn().mockResolvedValue(),
    route: jest.fn().mockResolvedValue(),
  };
  browser = {
    isConnected: jest.fn().mockReturnValue(true),
    newContext: jest.fn().mockResolvedValue(context),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(),
  };
  launchMock = jest.fn().mockResolvedValue(browser);
  const playwright = () => ({ chromium: { launch: launchMock } });
  if (PLAYWRIGHT) jest.doMock(PLAYWRIGHT, playwright);
  else jest.doMock('playwright-core', playwright, { virtual: true });
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  return require('../../bot/shared/utils/html-to-pdf');
}

/** Drive the registered route handler with one URL; report what it did. */
async function routeOutcome(url) {
  expect(context.route).toHaveBeenCalledTimes(1);
  const handler = context.route.mock.calls[0][1];
  const route = {
    request: () => ({ url: () => url }),
    abort: jest.fn().mockResolvedValue(),
    continue: jest.fn().mockResolvedValue(),
    fulfill: jest.fn().mockResolvedValue(),
  };
  await handler(route);
  if (route.abort.mock.calls.length) return 'abort';
  if (route.continue.mock.calls.length) return 'continue';
  return 'none';
}

afterEach(() => jest.resetModules());

describe.each([
  ['htmlToPdf', (m, o) => m.htmlToPdf('<html></html>', o)],
  ['htmlToImage', (m, o) => m.htmlToImage('<div class="card">x</div>', o)],
])('%s with { untrusted: true }', (name, call) => {
  it('opens the context with JavaScript disabled', async () => {
    const m = load();
    await call(m, { untrusted: true });
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(browser.newContext.mock.calls[0][0]).toEqual(expect.objectContaining({ javaScriptEnabled: false }));
  });

  // The route sees only what the page's renderer asks for. Chromium's
  // prefetch, preconnect and the frames of iframe/object go out from the
  // browser's own network service, past it; offline plus a proxy that
  // nothing listens on closes that path too.
  it('opens the context offline, behind a proxy nothing listens on', async () => {
    const m = load();
    await call(m, { untrusted: true });
    const opts = browser.newContext.mock.calls[0][0];
    expect(opts.offline).toBe(true);
    expect(opts.proxy).toEqual({ server: 'http://127.0.0.1:9' });
  });

  it('routes before the content is set', async () => {
    const m = load();
    await call(m, { untrusted: true });
    expect(context.route.mock.invocationCallOrder[0]).toBeLessThan(page.setContent.mock.invocationCallOrder[0]);
  });

  it.each([
    'http://127.0.0.1:47123/',
    'http://169.254.169.254/latest/meta-data/',
    'https://example.invalid/x.png',
    'file:///etc/passwd',
    'ws://127.0.0.1/',
  ])('aborts a request to %s', async (url) => {
    const m = load();
    await call(m, { untrusted: true });
    expect(await routeOutcome(url)).toBe('abort');
  });

  it.each(['data:font/ttf;base64,AAAA', 'data:image/png;base64,AAAA', 'about:blank'])(
    'lets %s through', async (url) => {
      const m = load();
      await call(m, { untrusted: true });
      expect(await routeOutcome(url)).toBe('continue');
    },
  );

  it('still renders and closes the context', async () => {
    const m = load();
    const buf = await call(m, { untrusted: true });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(context.close).toHaveBeenCalled();
  });
});

describe('other callers are unchanged', () => {
  it('htmlToPdf without the option: same context, no route', async () => {
    const m = load();
    await m.htmlToPdf('<html></html>');
    expect(browser.newContext).toHaveBeenCalledWith();
    expect(context.route).not.toHaveBeenCalled();
  });

  it('htmlToImage without the option: same context options, no route', async () => {
    const m = load();
    await m.htmlToImage('<div class="card">x</div>', { width: 540 });
    expect(browser.newContext).toHaveBeenCalledWith({ viewport: { width: 540, height: 100 }, deviceScaleFactor: 2 });
    expect(context.route).not.toHaveBeenCalled();
  });
});
