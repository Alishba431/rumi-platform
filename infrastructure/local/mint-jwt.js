#!/usr/bin/env node
/**
 * Mint a Supabase-style API key for the local stack (infrastructure/local/up.sh).
 *
 * A Supabase "service_role key" is just an HS256 JWT whose `role` claim names
 * a database role. PostgREST checks the signature against its jwt-secret and
 * then runs the request as that role. This script signs one with Node's own
 * crypto, so the local stack needs no npm packages.
 *
 * Usage:
 *   node infrastructure/local/mint-jwt.js --secret-file <path> [--role service_role|anon|authenticated] [--days N]
 *
 * The secret file is used byte-for-byte (no trimming), because that is how
 * PostgREST reads `jwt-secret = "@<path>"`. Write it without a trailing newline.
 */

const crypto = require('crypto');
const fs = require('fs');

const ROLES = ['anon', 'authenticated', 'service_role'];
const TEN_YEARS = 10 * 365 * 24 * 60 * 60;

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * @param {object} opts
 * @param {string} opts.secret            the PostgREST jwt-secret (>= 32 chars)
 * @param {string} opts.role              anon | authenticated | service_role
 * @param {number} [opts.now]             issued-at, seconds since epoch
 * @param {number} [opts.expiresInSeconds] lifetime, default ten years
 * @returns {string} header.payload.signature
 */
function mintJwt({ secret, role, now, expiresInSeconds = TEN_YEARS } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('the JWT secret must be at least 32 characters (PostgREST rejects shorter ones)');
  }
  if (!ROLES.includes(role)) {
    throw new Error(`unknown role "${role}" (use one of: ${ROLES.join(', ')})`);
  }
  const iat = Number.isInteger(now) ? now : Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ iss: 'rumi-local-stack', role, iat, exp: iat + expiresInSeconds });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function parseArgs(argv) {
  const args = { role: 'service_role', days: null, secretFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--secret-file') { args.secretFile = value; i += 1; }
    else if (flag === '--role') { args.role = value; i += 1; }
    else if (flag === '--days') { args.days = Number(value); i += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.secretFile) throw new Error('missing --secret-file <path>');
  return args;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const secret = fs.readFileSync(args.secretFile, 'utf8');
    const opts = { secret, role: args.role };
    if (args.days) opts.expiresInSeconds = Math.round(args.days * 24 * 60 * 60);
    process.stdout.write(`${mintJwt(opts)}\n`);
  } catch (err) {
    process.stderr.write(`mint-jwt: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { mintJwt, ROLES };
