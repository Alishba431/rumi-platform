/**
 * infrastructure/local/mint-jwt.js — the key the local stack hands to the bot.
 *
 * PostgREST only accepts a request whose JWT is HS256-signed with its own
 * jwt-secret and carries a `role` claim naming a database role. If either is
 * wrong, every query from the bot fails with 401, so pin both here.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../infrastructure/local/mint-jwt.js');
const { mintJwt } = require(SCRIPT);

const SECRET = 'a-local-test-secret-that-is-at-least-32-chars';

function b64urlDecode(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function expectedSignature(token, secret) {
  const [header, payload] = token.split('.');
  return crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
}

describe('mint-jwt', () => {
  it('returns a three-part token with an HS256 JWT header', () => {
    const token = mintJwt({ secret: SECRET, role: 'service_role' });
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(b64urlDecode(parts[0])).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('puts the requested role in the role claim, with iat < exp', () => {
    const now = 1700000000;
    const token = mintJwt({ secret: SECRET, role: 'anon', now, expiresInSeconds: 3600 });
    const payload = b64urlDecode(token.split('.')[1]);
    expect(payload.role).toBe('anon');
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBe(now + 3600);
  });

  it('signs with HMAC-SHA256 over header.payload using the secret', () => {
    const token = mintJwt({ secret: SECRET, role: 'service_role' });
    expect(token.split('.')[2]).toBe(expectedSignature(token, SECRET));
    expect(token.split('.')[2]).not.toBe(expectedSignature(token, `${SECRET}-other`));
  });

  it('refuses a secret shorter than 32 characters (PostgREST rejects those)', () => {
    expect(() => mintJwt({ secret: 'short', role: 'service_role' })).toThrow(/32/);
  });

  it('refuses a role outside anon / authenticated / service_role', () => {
    expect(() => mintJwt({ secret: SECRET, role: 'postgres' })).toThrow(/role/);
  });

  it('CLI: reads the secret file byte-for-byte and prints a verifiable token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rumi-mint-'));
    const file = path.join(dir, 'jwt-secret');
    fs.writeFileSync(file, SECRET);
    try {
      const out = execFileSync('node', [SCRIPT, '--secret-file', file, '--role', 'service_role'], { encoding: 'utf8' });
      const token = out.trim();
      expect(b64urlDecode(token.split('.')[1]).role).toBe('service_role');
      expect(token.split('.')[2]).toBe(expectedSignature(token, SECRET));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
