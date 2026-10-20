'use strict';
/**
 * Region gate — video quizzes are enabled per-region via region_features
 * (video_quizzes_enabled), because the video library behind them is tied to
 * one curriculum and is not offered everywhere.
 *
 * The gate is about the VIDEO library, so it applies to quizzes that have a
 * video and to nothing else. A lesson quiz (written from a coaching recording,
 * a lesson plan or a topic — quizzes.video_id is null) is shared by the same
 * class link and must join on every deployment.
 *
 * Two entry points are gated and both are asserted here:
 *  - offerAfterVideo: a region with the flag off must see the video exactly
 *    as before (no offer, standalone survey untouched).
 *  - beginFromCode:   an old VIDEO share link must stop admitting children when
 *    the flag is off — minting time does not grandfather delivery time — while
 *    a LESSON quiz's link keeps working.
 */

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(), set: jest.fn().mockResolvedValue(true), delete: jest.fn(),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
jest.mock('../../bot/shared/services/region-features.service', () => ({
  isVideoQuizzesEnabled: jest.fn(),
}));

const { isVideoQuizzesEnabled } = require('../../bot/shared/services/region-features.service');
const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const vq = require('../../bot/shared/services/quiz/video-quiz.service');
const share = require('../../bot/shared/services/quiz/video-quiz-share.service');

beforeEach(() => jest.clearAllMocks());

describe('region gate — offerAfterVideo', () => {
  test('flag OFF: returns false without even looking up the quiz', async () => {
    isVideoQuizzesEnabled.mockResolvedValue(false);
    const offered = await vq.offerAfterVideo({
      userId: 'u1', phone: '15550100000',
      video: { id: 'v1', clean_title: 'Adjectives' },
    });
    expect(offered).toBe(false);
    // The quiz lookup must not run — the gate sits in front of the DB.
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('flag ON: proceeds to the quiz lookup', async () => {
    isVideoQuizzesEnabled.mockResolvedValue(true);
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const eq2 = jest.fn(() => ({ maybeSingle }));
    const eq1 = jest.fn(() => ({ eq: eq2 }));
    supabase.from.mockReturnValue({ select: jest.fn(() => ({ eq: eq1 })) });
    const offered = await vq.offerAfterVideo({
      userId: 'u1', phone: '15550100000',
      video: { id: 'v1', clean_title: 'Adjectives' },
    });
    expect(offered).toBe(false); // no quiz row for this video
    expect(supabase.from).toHaveBeenCalledWith('quizzes');
  });
});

describe('region gate — beginFromCode', () => {
  const { createMemorySupabase } = require('./helpers/memory-supabase');
  const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const seed = () => createMemorySupabase({
    quiz_share_codes: [
      {
        id: 'sc-video', code: 'VIDEO2', quiz_id: 'q-video', video_id: 'v1', teacher_user_id: 't1',
        teacher_name: 'Teacher Example', topic: 'Adjectives', language: 'en', active: true, expires_at: future,
      },
      {
        id: 'sc-lesson', code: 'LESSN2', quiz_id: 'q-lesson', video_id: null, teacher_user_id: 't1',
        teacher_name: 'Teacher Example', topic: 'Fractions', language: 'en', active: true, expires_at: future,
      },
    ],
    users: [{ id: 't1', phone_number: '15550109999', name: 'Teacher Example' }],
    students: [],
  });

  test('flag OFF: a VIDEO quiz share code no longer admits a child', async () => {
    isVideoQuizzesEnabled.mockResolvedValue(false);
    const mem = seed();
    supabase.from.mockImplementation(mem.from);
    const handled = await share.beginFromCode('15550100001', 'VIDEO2');
    expect(handled).toBe(false);
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
  });

  test('flag OFF: a LESSON quiz share code (video_id null) still joins', async () => {
    isVideoQuizzesEnabled.mockResolvedValue(false);
    const mem = seed();
    supabase.from.mockImplementation(mem.from);
    const handled = await share.beginFromCode('15550100001', 'LESSN2');
    expect(handled).toBe(true);
    // A child we have never met is greeted and asked their name.
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('15550100001', expect.stringContaining('Fractions'));
  });

  test('flag ON: a VIDEO quiz share code joins as before', async () => {
    isVideoQuizzesEnabled.mockResolvedValue(true);
    const mem = seed();
    supabase.from.mockImplementation(mem.from);
    const handled = await share.beginFromCode('15550100001', 'VIDEO2');
    expect(handled).toBe(true);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('15550100001', expect.stringContaining('Adjectives'));
  });
});
