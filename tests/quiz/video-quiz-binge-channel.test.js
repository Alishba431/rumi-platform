'use strict';
/**
 * "Watch more" after a quiz never leaves a child with nothing.
 *
 * Yes opens the video menu, which is a Meta Flow: it is sent only to a
 * WhatsApp child on the Meta driver. A child on Baileys or Matrix — or any
 * child whose Flow send fails — is told how to reach the menu instead.
 */

const mockKv = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async (k) => (mockKv.has(k) ? mockKv.get(k) : null)),
  set: jest.fn(async (k, v) => { mockKv.set(k, v); return true; }),
  delete: jest.fn(async (k) => { mockKv.delete(k); return true; }),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendFlow: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/utils/constants', () => ({ STUDENT_VIDEOS_FLOW_ID: 'flow-videos-example' }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const binge = require('../../bot/shared/services/quiz/video-quiz-binge.service');

let saved;
beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  saved = process.env.CHANNEL_DRIVER;
});
afterEach(() => { if (saved === undefined) delete process.env.CHANNEL_DRIVER; else process.env.CHANNEL_DRIVER = saved; });

async function sayYes(phone) {
  await binge.offerMore({ phone, studentId: 'st-1', shareCodeId: 'sc-1', language: 'en' });
  return binge.handleMoreButton(binge.MORE_YES, phone);
}

test('Meta: yes opens the video menu Flow', async () => {
  process.env.CHANNEL_DRIVER = 'meta';
  await sayYes('15550100001');
  expect(WhatsAppService.sendFlow).toHaveBeenCalledWith('15550100001', expect.objectContaining({ flowId: 'flow-videos-example' }));
});

test.each([
  ['Baileys', 'baileys', '15550100001'],
  ['Matrix', 'meta', 'matrix:@child:example.org'],
])('%s: no Flow; the child is told how to reach the menu', async (_, driver, phone) => {
  process.env.CHANNEL_DRIVER = driver;
  await sayYes(phone);
  expect(WhatsAppService.sendFlow).not.toHaveBeenCalled();
  expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(phone, expect.stringContaining('/video'));
});

test('a Flow that fails to send falls back to the same line', async () => {
  process.env.CHANNEL_DRIVER = 'meta';
  WhatsAppService.sendFlow.mockResolvedValueOnce(false);
  await sayYes('15550100001');
  expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('15550100001', expect.stringContaining('/video'));
});
