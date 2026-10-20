/**
 * The coaching-sessions spreadsheet export groups each teacher's own completed
 * coaching sessions. A coach's observation of a teacher is a completed row
 * with user_id = teacher, but it is the coach's session, not the teacher's,
 * so it is not exported as one of theirs.
 */
const { createFakeSupabase } = require('../observe/_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [{ id: 't-1', first_name: 'Sam', last_name: 'Taylor', phone_number: '15550100002', school_name: 'Riverside Primary' }],
  coaching_sessions: [
    // written before the observe columns existed: no observation_type key at all
    { id: 'self-1', user_id: 't-1', status: 'completed', created_at: '2026-09-01T09:00:00Z', analysis_data: { topic: 'Fractions' } },
    { id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'completed',
      created_at: '2026-09-15T09:00:00Z', analysis_data: { topic: 'Observed lesson', scores: { overall_percentage: 38 } } },
  ],
});
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mockDb.client }));
jest.mock('../../bot/shared/storage/r2', () => ({ getPresignedUrl: jest.fn(async (u) => u) }));
// the spreadsheet file is the output boundary: capture the rows instead of writing a file
const mockSheets = {};
let mockWritten;
jest.mock('exceljs', () => ({
  Workbook: class {
    constructor() { this.xlsx = { writeFile: async (f) => { mockWritten(f); } }; }
    addWorksheet(name) {
      const rows = [];
      mockSheets[name] = rows;
      const row = () => ({ font: {}, fill: {}, alignment: {}, eachCell: () => {}, getCell: () => ({}) });
      return { rows, columns: [], addRow: (r) => { rows.push(r); return row(); }, getRow: row, getColumn: () => ({}), views: [], autoFilter: null };
    }
  },
}));

test('the export lists the teacher\'s own sessions and not the coach\'s observation of them', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const done = new Promise((resolve) => { mockWritten = resolve; });
  require('../../bot/scripts/generate-coaching-excel');
  await done;
  expect(mockSheets['Coaching Sessions'].map((r) => r.sessionId)).toEqual(['self-1']);
});
