'use strict';
/**
 * The classic (parents' phone) quiz recovers only ITS OWN sessions.
 *
 * On a Redis miss, QuizSessionService.getActiveState rebuilds the classic
 * quiz's state from the newest quiz_sessions row whose parent_phone is the
 * sender. The class-quiz engine (video-quiz.service startSession) also writes
 * the child's id into parent_phone, for every share-link and video session, so
 * a child in the middle of a lesson quiz who typed anything that is not a
 * letter ("banana") was claimed by the classic quiz and told "Reply Start Quiz
 * when you are ready to begin" (seen end to end on the Matrix rig). The classic
 * engine's sessions are source 'roster'; any other source is not its to resume.
 *
 * The real service runs on an in-memory supabase; Redis misses.
 */

const { createMemorySupabase } = require('./helpers/memory-supabase');

let mockMem;
jest.mock('../../bot/shared/config/supabase', () => ({
  from: (t) => mockMem.from(t),
  rpc: (...a) => mockMem.rpc(...a),
}));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  redis: { get: jest.fn(async () => null), set: jest.fn(), del: jest.fn() },
  setexWithCeiling: jest.fn(async () => 'OK'),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn(async () => true) }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/constants', () => ({ OPENAI_API_KEY: 'sk-test' }));
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })), { virtual: true });
// The queue service is loaded on the way in; aws-sdk is a bot-only dependency
// (absent where CI runs the root suite before bot deps install).
const { mockBotDependency } = require('../_helpers/mock-bot-dependency');
mockBotDependency('aws-sdk', () => ({ config: { update: () => {} }, SQS: function SQS() {} }));

const CHILD = 'mtx:15550100031';
const PARENT = '15550100042';

function session(over) {
  return {
    id: 's-1', quiz_id: 'quiz-1', student_id: 'st-1', current_difficulty: 3, total_questions_answered: 2,
    correct_answers: 1, status: 'in_progress', source: 'roster', created_at: '2026-10-01T09:00:00Z', ...over,
  };
}

let QuizSessionService;
function load(sessions) {
  mockMem = createMemorySupabase({ quiz_sessions: sessions, quiz_answers: [] });
  QuizSessionService = require('../../bot/shared/services/quiz/quiz-session.service');
}

describe('classic quiz state recovery on a Redis miss', () => {
  test.each(['share_link', 'video_solo'])('an in-progress %s session (the class-quiz engine) is not recovered', async (source) => {
    load([session({ id: 's-class', parent_phone: CHILD, source })]);
    expect(await QuizSessionService.getActiveState(CHILD)).toBeNull();
  });

  test('a roster session in progress is still recovered', async () => {
    load([session({ id: 's-roster', parent_phone: `+${PARENT}` })]);
    const state = await QuizSessionService.getActiveState(PARENT);
    expect(state).toEqual(expect.objectContaining({ sessionId: 's-roster', quizId: 'quiz-1' }));
  });

  test('a newer class-quiz session does not hide an older roster session in progress', async () => {
    load([
      session({ id: 's-roster', parent_phone: `+${PARENT}`, created_at: '2026-10-01T09:00:00Z' }),
      session({ id: 's-class', parent_phone: `+${PARENT}`, source: 'share_link', created_at: '2026-10-02T09:00:00Z' }),
    ]);
    const state = await QuizSessionService.getActiveState(PARENT);
    expect(state).toEqual(expect.objectContaining({ sessionId: 's-roster' }));
  });

  test('a newer completed roster session still wins over an older invited one (unchanged)', async () => {
    load([
      session({ id: 's-old', parent_phone: `+${PARENT}`, status: 'invited', created_at: '2026-09-01T09:00:00Z' }),
      session({ id: 's-new', parent_phone: `+${PARENT}`, status: 'completed', created_at: '2026-10-01T09:00:00Z' }),
    ]);
    expect(await QuizSessionService.getActiveState(PARENT)).toBeNull();
  });
});
