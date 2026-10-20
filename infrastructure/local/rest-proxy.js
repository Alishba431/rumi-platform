#!/usr/bin/env node
/**
 * The `/rest/v1` prefix proxy for the local stack (infrastructure/local/up.sh).
 *
 * supabase-js always calls `${SUPABASE_URL}/rest/v1/<table>`. A bare PostgREST
 * serves the same API at `/<table>`. This proxy strips the prefix and forwards
 * the request untouched (method, query, headers, body). Every other path, for
 * example `/storage/v1`, gets a 404 JSON answer: only the REST API is emulated.
 *
 * Node built-ins only, so it runs before `npm install`.
 *
 * Usage:
 *   node infrastructure/local/rest-proxy.js --port 54331 --target-port 54330 [--target-host 127.0.0.1] [--host 127.0.0.1]
 */

const http = require('http');

const PREFIX = '/rest/v1';

/**
 * Map a Supabase-style request path onto PostgREST's own path.
 * @param {string} url  request path plus query string
 * @returns {string|null} the upstream path, or null when the path is not under /rest/v1
 */
function rewritePath(url) {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return null;
  const rest = url.slice(PREFIX.length);
  if (rest === '') return '/';
  if (rest[0] === '?') return `/${rest}`;
  if (rest[0] === '/') return rest;
  return null; // e.g. /rest/v10
}

function sendJson(res, status, body) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * @param {object} opts
 * @param {string} [opts.targetHost] PostgREST host, default 127.0.0.1
 * @param {number} opts.targetPort   PostgREST port
 * @returns {http.Server} not yet listening
 */
function createProxy({ targetHost = '127.0.0.1', targetPort }) {
  return http.createServer((req, res) => {
    const upstreamPath = rewritePath(req.url);
    if (upstreamPath === null) {
      sendJson(res, 404, {
        message: 'only /rest/v1 is emulated by the Rumi local stack (no Storage, Auth or Realtime)',
        path: req.url,
      });
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    const upstream = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: upstreamPath, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      sendJson(res, 502, { message: `PostgREST is not reachable at ${targetHost}:${targetPort} (${err.code || err.message})` });
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
}

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 54331, targetHost: '127.0.0.1', targetPort: 54330 };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--host') args.host = value;
    else if (flag === '--port') args.port = Number(value);
    else if (flag === '--target-host') args.targetHost = value;
    else if (flag === '--target-port') args.targetPort = Number(value);
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`rest-proxy: ${err.message}\n`);
    process.exit(1);
  }
  const server = createProxy({ targetHost: args.targetHost, targetPort: args.targetPort });
  server.on('error', (err) => {
    process.stderr.write(`rest-proxy: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(args.port, args.host, () => {
    process.stdout.write(`rest-proxy: http://${args.host}:${args.port}${PREFIX} -> http://${args.targetHost}:${args.targetPort}\n`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main();

module.exports = { rewritePath, createProxy, PREFIX };
