/**
 * R2_FORCE_PATH_STYLE: an S3-compatible store other than Cloudflare R2 (a
 * local MinIO for a laptop setup, most self-hosted stores) only answers
 * path-style requests (<endpoint>/<bucket>/<key>), which is also the shape
 * the public URLs built below already have. Off by default, so an existing
 * R2 deployment sends exactly what it sent before.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('r2 client addressing style', () => {
  const SAVED = { ...process.env };
  afterEach(() => { process.env = { ...SAVED }; jest.resetModules(); });

  async function configUsed(env) {
    jest.resetModules();
    Object.assign(process.env, {
      R2_ENDPOINT: 'http://127.0.0.1:9000', R2_ACCESS_KEY_ID: 'local', R2_SECRET_ACCESS_KEY: 'local-secret', R2_BUCKET_NAME: 'rumi',
    }, env);
    const configs = [];
    jest.doMock('@aws-sdk/client-s3', () => ({
      S3Client: jest.fn(function S3Client(config) { configs.push(config); this.send = jest.fn(async () => ({})); }),
      PutObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(), GetObjectCommand: jest.fn(),
    }));
    jest.doMock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
    const r2 = require('../../bot/shared/storage/r2');
    const file = path.join(os.tmpdir(), `r2-style-${Date.now()}.mp3`);
    fs.writeFileSync(file, 'mp3');
    try {
      await r2.uploadAudio(file, '15550100001', 'm1');
    } finally {
      fs.unlinkSync(file);
    }
    return configs[0];
  }

  it('uses path-style requests when R2_FORCE_PATH_STYLE=true', async () => {
    expect((await configUsed({ R2_FORCE_PATH_STYLE: 'true' })).forcePathStyle).toBe(true);
  });

  it('leaves the SDK default alone when it is unset', async () => {
    delete process.env.R2_FORCE_PATH_STYLE;
    expect((await configUsed({})).forcePathStyle).toBeUndefined();
  });
});

// Object keys are built from channel identifiers and message ids. A Matrix
// identity ("mtx:1555…", "matrix:@teacher:server") and a Matrix event id
// ("$abc:server") carry characters several S3-compatible stores refuse (a
// local MinIO answered "Object name contains unsupported characters", and the
// reading assessment failed). Each segment is reduced to a safe set; a
// WhatsApp number and message id come out unchanged.
describe('r2 object keys', () => {
  const SAVED = { ...process.env };
  afterEach(() => { process.env = { ...SAVED }; jest.resetModules(); });

  async function keyFor(userId, messageId) {
    jest.resetModules();
    Object.assign(process.env, {
      R2_ENDPOINT: 'http://127.0.0.1:9000', R2_ACCESS_KEY_ID: 'local', R2_SECRET_ACCESS_KEY: 'local-secret', R2_BUCKET_NAME: 'rumi',
    });
    const puts = [];
    jest.doMock('@aws-sdk/client-s3', () => ({
      S3Client: jest.fn(function S3Client() { this.send = jest.fn(async () => ({})); }),
      PutObjectCommand: jest.fn(function PutObjectCommand(input) { puts.push(input); }),
      DeleteObjectCommand: jest.fn(), GetObjectCommand: jest.fn(),
    }));
    jest.doMock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
    const r2 = require('../../bot/shared/storage/r2');
    const file = path.join(os.tmpdir(), `r2-key-${Date.now()}.ogg`);
    fs.writeFileSync(file, 'ogg');
    try {
      const url = await r2.uploadAudio(file, userId, messageId);
      return { key: puts[0].Key, url };
    } finally {
      fs.unlinkSync(file);
    }
  }

  it('reduces a Matrix identity and event id to safe key characters', async () => {
    const { key, url } = await keyFor('mtx:15550100001', '$faMm8Kq:localhost');
    expect(key).toMatch(/^audio\/mtx_15550100001\/\d+__faMm8Kq_localhost\.ogg$/);
    expect(url.endsWith(key)).toBe(true);
  });

  it('leaves a WhatsApp number and message id unchanged', async () => {
    const { key } = await keyFor('15550100001', 'wamid.HBgLMTU1NTAxMDAwMDE');
    expect(key).toMatch(/^audio\/15550100001\/\d+_wamid\.HBgLMTU1NTAxMDAwMDE\.ogg$/);
  });
});
