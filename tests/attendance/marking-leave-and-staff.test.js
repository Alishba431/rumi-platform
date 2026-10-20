/**
 * Leave, and staff, on every marking surface.
 *
 * Marking is by exception: name who is away, everyone else is present. Leave is the
 * second kind of away, so it rides in the same answer:
 *
 *   text flow (Baileys / Matrix)  one reply — "2, 5 leave 3"
 *   Meta Flow                     a second checkbox group, `leave_students`
 *   Slack / Discord modals        a second field, `leave_student_ids`
 *
 * Every surface ends in the same nfm_reply / onFinish shape, and that shape is run
 * here through the real handler, delivery service and register — only the database
 * client, Redis and the channel send are stand-ins.
 */

const fs = require('fs');
const { createAttendanceDb } = require('./_helpers/attendance-db');

let mockDb;
const mockRedis = new Map();
const mockSendDocument = jest.fn();
const mockSendMessage = jest.fn();
const mockSent = [];

// Mocked at the client library (the network boundary): the real config/supabase.js loads and hands
// every service this in-memory client.
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t) => mockDb.client.from(t) }) }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async (k) => (mockRedis.has(k) ? mockRedis.get(k) : null)),
  set: jest.fn(async (k, v) => { mockRedis.set(k, v); return true; }),
  delete: jest.fn(async (k) => { mockRedis.delete(k); return true; }),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/storage/r2', () => ({
  uploadBuffer: jest.fn(), isR2Configured: () => false, getSignedUrl: jest.fn(),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendDocument: (...a) => mockSendDocument(...a),
  sendMessage: (...a) => mockSendMessage(...a),
}));
jest.mock('../../bot/shared/routes/reading-assessment-endpoint', () => ({ startAssessment: jest.fn() }));
jest.mock('../../bot/shared/routes/student-videos-endpoint', () => ({
  handleStudentVideosInit: jest.fn(), handleStudentVideosDataExchange: jest.fn(),
}));
jest.mock('../../bot/shared/routes/settings-endpoint', () => ({
  handleSettingsInit: jest.fn(), handleSettingsDataExchange: jest.fn(),
}));

const textFlow = require('../../bot/shared/services/messaging/text-flow');
const definitions = require('../../bot/shared/services/messaging/text-flow-definitions');
const FlowResponseHandler = require('../../bot/shared/handlers/flow-response.handler');
const attendanceMarking = require('../../bot/shared/routes/attendance-marking-endpoint');
const slackView = require('../../bot/shared/routes/slack-views/attendance-marking.view');
const discordView = require('../../bot/shared/routes/discord-views/attendance-marking.view');

const PHONE = '15550100001';

const KIDS = [
  { id: 'k1', list_id: 'L1', roll_number: 1, student_name: 'Dana Lee', is_active: true },
  { id: 'k2', list_id: 'L1', roll_number: 2, student_name: 'Eli Moss', is_active: true },
  { id: 'k3', list_id: 'L1', roll_number: 3, student_name: 'Fay Ng', is_active: true },
];

const STAFF_USERS = [
  { id: 'h1', name: 'Grace Hall', role: 'head_teacher', school_id: 'sch1' },
  { id: 't1', name: 'Amara Okafor', role: null, school_id: 'sch1' },
  { id: 't2', name: 'Ben Ito', role: null, school_id: 'sch1' },
];

function seed() {
  mockDb = createAttendanceDb({
    student_lists: [{ id: 'L1', user_id: 'u1', class_name: 'Grade 5', section: 'A', is_active: true }],
    students: KIDS,
    schools: [{ id: 'sch1', name: 'Hillside Primary' }],
    users: [{ id: 'u1', name: 'Ivy Park', role: null }, ...STAFF_USERS],
  });
}

const CLASS_SESSION = {
  state: 'AWAITING_VERIFICATION',
  subject: 'class',
  selectedClass: { id: 'L1', class_name: 'Grade 5', section: 'A' },
  selectedListId: 'L1',
  selectedDate: '2026-09-04',
  sessionType: 'full_day',
  students: KIDS,
};

const STAFF_SESSION = {
  state: 'AWAITING_VERIFICATION',
  subject: 'staff',
  schoolId: 'sch1',
  selectedClass: { id: 'sch1', class_name: 'Hillside Primary' },
  selectedListId: null,
  selectedDate: '2026-09-04',
  sessionType: 'full_day',
  students: [
    { id: 't1', student_name: 'Amara Okafor' },
    { id: 't2', student_name: 'Ben Ito' },
  ],
};

function useSession(userId, session) {
  mockRedis.set(`attendance:session:${userId}`, JSON.stringify(session));
}

async function runTextFlow(userId, reply) {
  const ctx = { _ctx: { userId, flowToken: `${userId}:attendance-mark:1`, phone: PHONE } };
  const first = await textFlow.start(PHONE, 'attendance-mark', {}, ctx);
  const done = await textFlow.advance(PHONE, reply);
  const { metaMessage } = await textFlow.getDefinition('attendance-mark').onComplete(PHONE, done.answers, done.context);
  return { first, metaMessage, responseJson: JSON.parse(metaMessage.interactive.nfm_reply.response_json) };
}

beforeAll(() => definitions.registerAll());

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  mockSent.length = 0;
  seed();
  mockSendMessage.mockResolvedValue(true);
  mockSendDocument.mockImplementation(async (to, filePath, fileName, caption) => {
    mockSent.push({ to, fileName, caption, buffer: fs.readFileSync(filePath) });
    return true;
  });
});

describe('one reply names who is absent and who is on leave', () => {
  const students = KIDS;

  it.each([
    ['2', ['k2'], []],
    ['2, 3', ['k2', 'k3'], []],
    ['2 leave 3', ['k2'], ['k3']],
    ['1, 2 on leave 3', ['k1', 'k2'], ['k3']],
    ['leave 1', [], ['k1']],
    ['absent 2 leave 1, 3', ['k2'], ['k1', 'k3']],
    ['none', [], []],
  ])('%j → absent %j, leave %j', (reply, absent, leave) => {
    expect(definitions.parseAttendanceReply(reply, students)).toEqual({ absentIds: absent, leaveIds: leave });
  });

  it('a person named in both lists counts once, as leave', () => {
    expect(definitions.parseAttendanceReply('2 leave 2', students)).toEqual({ absentIds: [], leaveIds: ['k2'] });
  });
});

describe('the text flow (Baileys, Matrix)', () => {
  it('asks who is absent and tells the teacher how to say who is on leave', async () => {
    useSession('u1', CLASS_SESSION);
    const { first } = await runTextFlow('u1', '2');
    expect(first.prompt.body).toContain('3. Fay Ng');
    expect(first.prompt.body).toMatch(/leave/i);
  });

  it('carries leave_students in the same nfm_reply as absent_students', async () => {
    useSession('u1', CLASS_SESSION);
    const { responseJson } = await runTextFlow('u1', '2 leave 3');
    expect(responseJson.absent_students).toEqual(['k2']);
    expect(responseJson.leave_students).toEqual(['k3']);
    expect(responseJson.flow_token).toBe('u1:L1:2026-09-04:full_day:Grade%205');
  });

  it('for staff, names the school and carries a staff token', async () => {
    useSession('h1', STAFF_SESSION);
    const { first, responseJson } = await runTextFlow('h1', '2');
    expect(first.prompt.body).toContain('Hillside Primary');
    expect(responseJson.flow_token).toBe('h1:staff:2026-09-04:full_day:Hillside%20Primary');
  });
});

describe('the submission, end to end through the real handler and delivery', () => {
  it('a class: Leave is saved, counted and in the register the teacher receives', async () => {
    useSession('u1', CLASS_SESSION);
    const { metaMessage } = await runTextFlow('u1', '2 leave 3');

    const ok = await FlowResponseHandler.handleAttendanceMarkingFlow(metaMessage, PHONE, 'u1');

    expect(ok).toBe(true);
    const records = mockDb.rowsOf('attendance_records');
    expect(records.find((r) => r.student_id === 'k3').status).toBe('leave');
    expect(mockDb.rowsOf('attendance_sessions')[0]).toMatchObject({ session_date: '2026-09-04', leave_count: 1 });

    const confirmation = mockSendMessage.mock.calls.map((c) => c[1]).join('\n');
    expect(confirmation).toMatch(/On leave: 1/);
    // The class as the teacher knows it — with its section, not just the name in the token.
    expect(confirmation).toMatch(/Class: Grade 5 - A/);

    const { fileName, buffer } = mockSent[0];
    expect(fileName).toBe('Attendance_Grade_5_A_September_2026.xlsx');
    const [sheet] = JSON.parse(buffer.toString());
    expect(sheet.rows.find((r) => r[1] === 'Fay Ng')[2 + 4 - 1]).toBe('L');
  });

  it('staff: the head teacher\'s submission writes staff rows and sends the staff register', async () => {
    useSession('h1', STAFF_SESSION);
    const { metaMessage } = await runTextFlow('h1', 'leave 2');

    const ok = await FlowResponseHandler.handleAttendanceMarkingFlow(metaMessage, '15550100009', 'h1');

    expect(ok).toBe(true);
    const rows = mockDb.rowsOf('teacher_attendance_records');
    expect(rows.map((r) => [r.teacher_id, r.status]).sort()).toEqual([['t1', 'present'], ['t2', 'leave']]);
    expect(mockDb.rowsOf('attendance_sessions')).toHaveLength(0);
    expect(mockSent[0].fileName).toBe('Staff_Attendance_Hillside_Primary_September_2026.xlsx');

    // The confirmation reads like the register it announces: a school, and the staff rate —
    // approved leave excused, so one present of one working is 100%, not 50%.
    const confirmation = mockSendMessage.mock.calls.map((c) => c[1]).join('\n');
    expect(confirmation).toMatch(/School: Hillside Primary/);
    expect(confirmation).toMatch(/Attendance Rate: 100%/);
  });

  it('a staff token from someone who is not a head teacher writes nothing', async () => {
    useSession('u1', { ...STAFF_SESSION });
    const { metaMessage } = await runTextFlow('u1', '1');
    // u1 is a teacher; the token says staff.
    await FlowResponseHandler.handleAttendanceMarkingFlow(metaMessage, PHONE, 'u1');
    expect(mockDb.rowsOf('teacher_attendance_records')).toHaveLength(0);
    expect(mockSent).toHaveLength(0);
  });
});

describe('Slack and Discord tap-to-mark', () => {
  it('the shared endpoint builds Leave records from leave_student_ids and says which register it is', async () => {
    useSession('h1', STAFF_SESSION);
    const res = await attendanceMarking.handleMarkingExchange('h1', 'MARK_ABSENT', {
      absent_student_ids: [], leave_student_ids: ['t2'],
    });
    expect(res.data.subject).toBe('staff');
    expect(res.data.records.find((r) => r.studentId === 't2').status).toBe('leave');
    expect(res.data.success_message).toMatch(/On leave: 1/);
  });

  it('Slack shows a second checkbox group for leave and reads it back', () => {
    const view = slackView.screenToView('MARK_ABSENT', { students: [{ id: 'k1', title: 'Dana Lee' }] }, { metadata: 'm' });
    expect(view.blocks.map((b) => b.block_id)).toContain('leave_students_block');
    const data = slackView.viewToScreenData('MARK_ABSENT', {
      absent_students_block: { absent_students: { selected_options: [] } },
      leave_students_block: { leave_students: { selected_options: [{ value: 'k1' }] } },
    });
    expect(data).toEqual({ absent_student_ids: [], leave_student_ids: ['k1'] });
  });

  it('Discord adds leave pickers after the absent ones and merges them', () => {
    const { steps } = discordView.screenToSteps('MARK_ABSENT', { students: [{ id: 'k1', title: 'Dana Lee' }] });
    expect(steps.map((s) => s.fieldName)).toEqual(['absent_students_chunk_0', 'leave_students_chunk_0']);
    expect(discordView.mergeScreenData('MARK_ABSENT', {
      absent_students_chunk_0: ['k1'], leave_students_chunk_0: ['k2'],
    })).toEqual({ absent_student_ids: ['k1'], leave_student_ids: ['k2'] });
  });
});
