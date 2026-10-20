/**
 * The native WhatsApp Flow (Meta Cloud API) for tap-to-mark.
 *
 * The Flow JSON gains a second CheckboxGroup, `leave_students`, carried in the same
 * completion payload as `absent_students`. The data endpoint's INIT serves the
 * roster for a class token, or — for a staff token — the head teacher's staff,
 * re-checking the role rather than trusting the token. The day it shows is the
 * token's day, read as a date string (no timezone shift).
 */

const fs = require('fs');
const path = require('path');
const { createAttendanceDb } = require('./_helpers/attendance-db');

let mockDb;
// Mocked at the client library (the network boundary): the real config/supabase.js loads and hands
// every service this in-memory client.
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t) => mockDb.client.from(t) }) }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
// The router also mounts unrelated Flow endpoints; their dependencies (queues, media) are bot-only
// packages CI's root suite does not install, and nothing here reaches them.
jest.mock('../../bot/shared/routes/homework-request-endpoint', () => ({}));
jest.mock('../../bot/shared/routes/pic-lp-endpoint', () => ({}));
jest.mock('../../bot/shared/routes/student-videos-endpoint', () => ({}));
jest.mock('../../bot/shared/routes/status-flow-endpoint', () => ({}));
jest.mock('../../bot/shared/routes/registration-endpoint', () => ({}));
jest.mock('../../bot/shared/routes/settings-endpoint', () => ({}));

const flowRouter = require('../../bot/shared/routes/flow-endpoint.routes');

const FLOW_JSON = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../docs/flows/attendance-marking-flow.json'), 'utf8',
));

beforeEach(() => {
  mockDb = createAttendanceDb({
    schools: [{ id: 'sch1', name: 'Hillside Primary' }],
    users: [
      { id: 'u1', name: 'Ivy Park', role: null, school_id: 'sch1' },
      { id: 'h1', name: 'Grace Hall', role: 'head_teacher', school_id: 'sch1' },
      { id: 't1', name: 'Amara Okafor', role: null, school_id: 'sch1' },
    ],
    student_lists: [{ id: 'L1', user_id: 'u1', class_name: 'Grade 5', section: 'A', is_active: true }],
    students: [{ id: 'k1', list_id: 'L1', roll_number: 1, student_name: 'Dana Lee', is_active: true }],
  });
});

describe('the Flow JSON', () => {
  const form = FLOW_JSON.screens[0].layout.children[0].children;

  it('has a leave CheckboxGroup over the same roster', () => {
    const leave = form.find((c) => c.name === 'leave_students');
    expect(leave).toMatchObject({ type: 'CheckboxGroup', 'data-source': '${data.students}', required: false });
  });

  it('completes with leave_students beside absent_students', () => {
    const footer = form.find((c) => c.type === 'Footer');
    expect(footer['on-click-action'].payload).toMatchObject({
      absent_students: '${form.absent_students}',
      leave_students: '${form.leave_students}',
    });
  });
});

describe('the data endpoint', () => {
  it('INIT for a class serves its students and the token\'s day', async () => {
    const res = await flowRouter.handleAttendanceMarkingRequest({
      action: 'INIT', flow_token: 'u1:L1:2026-09-30:full_day:Grade%205',
    });
    expect(res.screen).toBe('MARK_ABSENT');
    expect(res.data.students).toEqual([{ id: 'k1', title: '1. Dana Lee' }]);
    expect(res.data.date_display).toBe('Wednesday 30 September 2026');
  });

  it('INIT for staff serves the head teacher\'s staff', async () => {
    const res = await flowRouter.handleAttendanceMarkingRequest({
      action: 'INIT', flow_token: 'h1:staff:2026-09-30:full_day:Hillside%20Primary',
    });
    expect(res.screen).toBe('MARK_ABSENT');
    expect(res.data.class_name).toBe('Hillside Primary — staff');
    expect(res.data.students.map((s) => s.id)).toEqual(['t1', 'u1']);
  });

  it('INIT for staff from someone who is not a head teacher is refused', async () => {
    const res = await flowRouter.handleAttendanceMarkingRequest({
      action: 'INIT', flow_token: 'u1:staff:2026-09-30:full_day:Hillside%20Primary',
    });
    expect(res.screen).not.toBe('MARK_ABSENT');
  });

  it('a data_exchange submission carries leave_students', async () => {
    const res = await flowRouter.handleAttendanceMarkingRequest({
      action: 'data_exchange', flow_token: 'u1:L1:2026-09-30:full_day:Grade%205', screen: 'MARK_ABSENT',
      data: { absent_students: [], leave_students: ['k1'] },
    });
    expect(res.data.extension_message_response.params.leave_students).toEqual(['k1']);
  });
});
