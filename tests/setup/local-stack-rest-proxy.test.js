/**
 * infrastructure/local/rest-proxy.js — supabase-js always calls
 * `${SUPABASE_URL}/rest/v1/<table>`, but a bare PostgREST serves `/<table>`.
 * The proxy strips the prefix and forwards everything else untouched.
 */

const http = require('http');

const { rewritePath, createProxy } = require('../../infrastructure/local/rest-proxy');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, { method = 'GET', urlPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('rewritePath', () => {
  it.each([
    ['/rest/v1/users?select=id&limit=1', '/users?select=id&limit=1'],
    ['/rest/v1/', '/'],
    ['/rest/v1', '/'],
    ['/rest/v1?select=*', '/?select=*'],
    ['/rest/v1/rpc/exec_sql', '/rpc/exec_sql'],
  ])('%s -> %s', (input, expected) => {
    expect(rewritePath(input)).toBe(expected);
  });

  it.each([
    ['/storage/v1/object/bucket/key'],
    ['/rest/v10/users'],
    ['/users'],
    ['/'],
  ])('%s is not proxied (null)', (input) => {
    expect(rewritePath(input)).toBeNull();
  });
});

describe('createProxy (live, ephemeral ports)', () => {
  let upstream;
  let proxy;
  let proxyPort;
  const seen = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(201, { 'content-type': 'application/json', 'content-range': '0-0/1' });
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
    });
    const upstreamPort = await listen(upstream);
    proxy = createProxy({ targetHost: '127.0.0.1', targetPort: upstreamPort });
    proxyPort = await listen(proxy);
  });

  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  it('forwards /rest/v1/<path> to /<path> with method, query, headers and body intact', async () => {
    const res = await request(proxyPort, {
      method: 'POST',
      urlPath: '/rest/v1/users?select=id',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', prefer: 'return=representation' },
      body: '{"phone_number":"15550001234"}',
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ ok: true, url: '/users?select=id' });
    expect(res.headers['content-range']).toBe('0-0/1');
    const last = seen[seen.length - 1];
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/users?select=id');
    expect(last.headers.authorization).toBe('Bearer test-token');
    expect(last.headers.prefer).toBe('return=representation');
    expect(last.body).toBe('{"phone_number":"15550001234"}');
  });

  it('answers 404 JSON for paths outside /rest/v1 without touching upstream', async () => {
    const before = seen.length;
    const res = await request(proxyPort, { urlPath: '/storage/v1/object/b/k' });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).message).toMatch(/only \/rest\/v1/);
    expect(seen.length).toBe(before);
  });

  it('answers 502 when PostgREST is not reachable', async () => {
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await close(dead);
    const lonely = createProxy({ targetHost: '127.0.0.1', targetPort: deadPort });
    const port = await listen(lonely);
    try {
      const res = await request(port, { urlPath: '/rest/v1/users' });
      expect(res.status).toBe(502);
      expect(JSON.parse(res.body).message).toMatch(/PostgREST/);
    } finally {
      await close(lonely);
    }
  });
});
