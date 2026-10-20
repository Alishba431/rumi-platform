/**
 * Student Videos Flow Endpoint v2 — Scenario Tests
 *
 * Contract for the 3-screen video browse flow:
 *   SELECT_GRADE → SELECT_SUBJECT → SELECT_TOPIC → SUCCESS
 *
 * Confirms:
 * - Distinct grades / subjects, sourced only from migration_status='done'.
 * - Chapter prefix shown only when ≥ 2 videos share it; suppressed otherwise.
 * - Topic dropdown carries the row id directly (no fragile text re-resolution).
 * - selectTopic resolves the row by id, sends an immediate pre-delivery ack,
 *   schedules the async video delivery with a clean caption, returns SUCCESS.
 */

const {
  handleStudentVideosInit,
  handleStudentVideosDataExchange,
  gradeTitle,
  gradeRank,
} = require('../../bot/shared/routes/student-videos-endpoint');

// Programmable Supabase mock — FIFO queue of canned responses; each `.from()`
// shifts the next response and serves it on terminal `.then` or `.single()`.
let mockQueue = [];
jest.mock('../../bot/shared/config/supabase', () => {
  const makeQuery = () => {
    const result = mockQueue.shift() || { data: [], error: null };
    const q = {
      select: () => q,
      eq: () => q,
      // bd-2318: the query now filters `.is('superseded_by', null)` to hide
      // duplicate videos. A builder mock that lacks a link in the chain fails
      // with "is is not a function" rather than a useful assertion — the
      // chained-Supabase-call trap from the pre-merge checklist.
      is: () => q,
      not: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve(result),
      single: () => Promise.resolve(result),
      then: (resolve) => resolve(result),
    };
    return q;
  };
  return { from: jest.fn(() => makeQuery()) };
});

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendVideoFromUrl: jest.fn().mockResolvedValue(true),
  sendMessage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

beforeEach(() => {
  mockQueue = [];
  jest.clearAllMocks();
});

const flush = () => new Promise((r) => setImmediate(r));

describe('helpers', () => {
  test('grade ordering: NURSERY < KG < 1 < 6', () => {
    expect(gradeRank('NURSERY')).toBeLessThan(gradeRank('KG'));
    expect(gradeRank('KG')).toBeLessThan(gradeRank('1'));
    expect(gradeRank('1')).toBeLessThan(gradeRank('6'));
  });
  test('grade titles', () => {
    expect(gradeTitle('NURSERY')).toBe('Nursery');
    expect(gradeTitle('KG')).toBe('KG');
    expect(gradeTitle('3')).toBe('Grade 3');
  });
});

describe('INIT', () => {
  test('returns distinct grades, ordered, sourced from done rows only', async () => {
    mockQueue = [{ data: [
      { grade: '1' }, { grade: '1' }, { grade: 'NURSERY' }, { grade: 'KG' }, { grade: '6' },
    ], error: null }];
    const res = await handleStudentVideosInit('user-1:tok');
    expect(res.screen).toBe('SELECT_GRADE');
    expect(res.data.grades.map((g) => g.id)).toEqual(['NURSERY', 'KG', '1', '6']);
    expect(res.data.grades[0].title).toBe('Nursery');
  });
});

describe('SELECT_GRADE → SELECT_SUBJECT', () => {
  test('returns distinct subjects for the grade', async () => {
    mockQueue = [{ data: [{ subject: 'English' }, { subject: 'Maths' }, { subject: 'English' }], error: null }];
    const res = await handleStudentVideosDataExchange('u:tok', 'SELECT_GRADE', { grade: '1' });
    expect(res.screen).toBe('SELECT_SUBJECT');
    expect(res.data.subjects.map((s) => s.id).sort()).toEqual(['English', 'Maths']);
    expect(res.data.grade_value).toBe('1');
    expect(res.data.grade_display).toBe('Grade 1');
  });
  test('missing grade → error', async () => {
    const res = await handleStudentVideosDataExchange('u:tok', 'SELECT_GRADE', {});
    expect(res.data.error).toBeDefined();
  });
});

describe('SELECT_SUBJECT → SELECT_TOPIC', () => {
  test('builds a single topic dropdown with chapter prefix only when shared', async () => {
    mockQueue = [{ data: [
      // Two rows share chapter "Numbers" → prefix shown.
      { id: 'uuid-1', clean_chapter: 'Numbers', clean_title: 'Identifying Even and Odd Numbers', r2_url: 'r2://1' },
      { id: 'uuid-2', clean_chapter: 'Numbers', clean_title: 'Roman Numbers', r2_url: 'r2://2' },
      // Singleton chapter "Shapes" — only one video, prefix suppressed.
      { id: 'uuid-3', clean_chapter: 'Shapes', clean_title: 'Picture Graphs', r2_url: 'r2://3' },
    ], error: null }];
    const res = await handleStudentVideosDataExchange('u:tok', 'SELECT_SUBJECT', { grade: '3', subject: 'Maths' });
    expect(res.screen).toBe('SELECT_TOPIC');
    const byId = Object.fromEntries(res.data.videos.map((v) => [v.id, v.title]));
    expect(byId['uuid-1']).toBe('Numbers · Identifying Even and Odd Numbers');
    expect(byId['uuid-2']).toBe('Numbers · Roman Numbers');
    expect(byId['uuid-3']).toBe('Picture Graphs'); // singleton: no chapter prefix
    expect(res.data.header_text).toBe('Grade 3 — Maths');
  });

  test('empty (grade, subject) → error, no crash', async () => {
    mockQueue = [{ data: [], error: null }];
    const res = await handleStudentVideosDataExchange('u:tok', 'SELECT_SUBJECT', { grade: '6', subject: 'History' });
    expect(res.data.error).toBeDefined();
  });
});

describe('SELECT_TOPIC → SUCCESS (deliver)', () => {
  test('resolves by row id, sends pre-delivery ack, delivers with clean caption', async () => {
    mockQueue = [
      // .single() row lookup
      { data: { id: 'uuid-1', grade: '3', subject: 'Maths', clean_chapter: 'Numbers',
                clean_title: 'Identifying Even and Odd Numbers', r2_url: 'https://r2/sample.mp4',
                migration_status: 'done' }, error: null },
      // sendPreDeliveryAck → getPhoneForUser .single()
      { data: { phone_number: '923009999999' }, error: null },
      // deliverVideoAsync → getPhoneForUser .single()
      { data: { phone_number: '923009999999' }, error: null },
    ];
    const res = await handleStudentVideosDataExchange('u9:tok', 'SELECT_TOPIC', {
      grade: '3', subject: 'Maths', video: 'uuid-1',
    });
    expect(res.screen).toBe('SUCCESS');
    expect(res.data.message).toContain('Identifying Even and Odd Numbers');

    // Pre-delivery ack should already have been awaited before SUCCESS returned.
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    const [ackPhone, ackText] = WhatsAppService.sendMessage.mock.calls[0];
    expect(ackPhone).toBe('923009999999');
    expect(ackText).toContain('Sending your video');
    expect(ackText).toContain('Identifying Even and Odd Numbers');

    // Async delivery scheduled — fires on next tick.
    await flush();
    expect(WhatsAppService.sendVideoFromUrl).toHaveBeenCalledWith(
      '923009999999',
      'https://r2/sample.mp4',
      expect.stringContaining('Identifying Even and Odd Numbers'),
    );
    const caption = WhatsAppService.sendVideoFromUrl.mock.calls[0][2];
    expect(caption).toMatch(/^📚 Grade 3 · Maths\n/);
    expect(caption).not.toMatch(/—.*—/); // no fragmented em-dashes
  });

  test('a teacher on Matrix (no users.phone_number) gets the ack and the video in the chat the picker was opened from', async () => {
    mockQueue = [
      { data: { id: 'uuid-1', grade: '3', subject: 'Maths', clean_chapter: 'Numbers',
                clean_title: 'Identifying Even and Odd Numbers', r2_url: 'https://r2/sample.mp4',
                migration_status: 'done' }, error: null },
    ];
    // The opener puts the recipient at the end of the token: userId:student-videos:<ts>:<recipient>.
    const res = await handleStudentVideosDataExchange('u9:student-videos:1790000000000:mtx:15550100001', 'SELECT_TOPIC', {
      grade: '3', subject: 'Maths', video: 'uuid-1',
    });
    expect(res.screen).toBe('SUCCESS');
    expect(WhatsAppService.sendMessage.mock.calls[0][0]).toBe('mtx:15550100001');
    await flush();
    expect(WhatsAppService.sendVideoFromUrl.mock.calls[0][0]).toBe('mtx:15550100001');
  });

  test('unknown video id → error, no delivery', async () => {
    mockQueue = [{ data: null, error: { message: 'not found' } }];
    const res = await handleStudentVideosDataExchange('u:tok', 'SELECT_TOPIC', {
      grade: '3', subject: 'Maths', video: 'no-such-id',
    });
    expect(res.data.error).toBeDefined();
    expect(WhatsAppService.sendVideoFromUrl).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
  });

  test('row not migration_status=done → error', async () => {
    mockQueue = [{ data: { id: 'x', grade: '3', subject: 'Maths', clean_title: 't',
                            r2_url: null, migration_status: 'broken_source' }, error: null }];
    const res = await handleStudentVideosDataExchange('u:tok', 'SELECT_TOPIC', {
      grade: '3', subject: 'Maths', video: 'x',
    });
    expect(res.data.error).toBeDefined();
  });

  test('unknown screen → graceful error', async () => {
    const res = await handleStudentVideosDataExchange('u:tok', 'WAT', {});
    expect(res.data.error).toBeDefined();
  });
});

// A child's "watch more videos" picker (video-quiz-binge) carries a
// `childpick:<phone>:<shareCodeId>:<studentId>:<language>:<ts>` token: there is
// no users row for a child, so the video goes to the phone on the token.
describe('a child\'s picker (childpick: token)', () => {
  const { logToFile } = require('../../bot/shared/utils/logger');
  const { logEvent } = require('../../bot/shared/utils/structured-logger');
  const supabase = require('../../bot/shared/config/supabase');
  const ChildFlowToken = require('../../bot/shared/services/quiz/child-flow-token');
  const CHILD = '15550100077';
  const childToken = () => ChildFlowToken.build({ phone: CHILD, shareCodeId: 'sc1', studentId: 'st1', language: 'en' });
  const VIDEO_ROW = { data: { id: 'uuid-1', grade: '3', subject: 'Maths', clean_chapter: 'Numbers',
    clean_title: 'Identifying Even and Odd Numbers', r2_url: 'https://r2/sample.mp4', migration_status: 'done' }, error: null };
  const logged = () => JSON.stringify([...logToFile.mock.calls, ...logEvent.mock.calls]);

  test('the ack and the video reach the child, with no teacher lookup', async () => {
    mockQueue = [VIDEO_ROW];
    const res = await handleStudentVideosDataExchange(childToken(), 'SELECT_TOPIC', {
      grade: '3', subject: 'Maths', video: 'uuid-1',
    });
    expect(res.screen).toBe('SUCCESS');
    expect(WhatsAppService.sendMessage.mock.calls[0][0]).toBe(CHILD);
    await flush(); await flush();
    expect(WhatsAppService.sendVideoFromUrl.mock.calls[0][0]).toBe(CHILD);
    // Only the video row is read: no users row is looked up, and no teacher
    // delivery row / class-share offer is made for a child.
    expect(supabase.from.mock.calls.map((c) => c[0])).toEqual(['student_videos']);
    expect(logEvent).toHaveBeenCalledWith('student_videos.delivered',
      expect.objectContaining({ shareCodeId: 'sc1', studentId: 'st1', userId: null }));
  });

  test('the child\'s phone never reaches a log line (INIT, data_exchange, delivery)', async () => {
    mockQueue = [{ data: [{ grade: '1' }], error: null }];
    await handleStudentVideosInit(childToken());
    mockQueue = [{ data: [{ subject: 'Maths' }], error: null }];
    await handleStudentVideosDataExchange(childToken(), 'SELECT_GRADE', { grade: '1' });
    mockQueue = [VIDEO_ROW];
    await handleStudentVideosDataExchange(childToken(), 'SELECT_TOPIC', { grade: '3', subject: 'Maths', video: 'uuid-1' });
    await flush(); await flush();
    expect(logToFile).toHaveBeenCalled();
    expect(logged()).not.toContain(CHILD);
  });

  test('a teacher token with the recipient on its end does not log that recipient (R-N1)', async () => {
    mockQueue = [{ data: [{ grade: '1' }], error: null }];
    await handleStudentVideosInit('u9:student-videos:1790000000000:15550100001');
    mockQueue = [{ data: [{ subject: 'Maths' }], error: null }];
    await handleStudentVideosDataExchange('u9:student-videos:1790000000000:mtx:15550100001', 'SELECT_GRADE', { grade: '1' });
    expect(logToFile).toHaveBeenCalled();
    expect(logged()).not.toContain('15550100001');
  });
});
