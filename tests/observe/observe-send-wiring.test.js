/**
 * Source guards for the report's wiring in files that boot servers or SQS
 * consumers on require (so they are checked statically):
 *  - the worker runs `observe_teacher_report` jobs, and a failure of one never
 *    marks the coaching session `failed` (the send service records its own
 *    delivery state and tells the coach);
 *  - a teacher's tap on the invite template's quick reply (Meta "button"
 *    message, payload observe_report_<id>) reaches the send service before
 *    any other template-button branch.
 */

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('sqs-worker', () => {
  const src = read('bot/workers/sqs-worker.js');

  test('executeJob has an observe_teacher_report case before default', () => {
    const at = src.indexOf("case 'observe_teacher_report'");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf('default:\n        throw new Error(`Unknown job type'));
    expect(src.slice(at, at + 400)).toMatch(/observe-send\.service'\)\.processTeacherReport\(sessionId, payload\)/);
  });

  test('handleJobFailure returns early for observe_teacher_report', () => {
    const fail = src.slice(src.indexOf('async handleJobFailure'));
    const early = fail.indexOf("jobType === 'observe_teacher_report'");
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(fail.indexOf("status: 'failed'"));
  });
});

describe('whatsapp-bot template button', () => {
  test('observe_report_ payloads go to the send service first', () => {
    const src = read('bot/whatsapp-bot.js');
    const branch = src.slice(src.indexOf("} else if (messageType === 'button' && message.button) {"));
    const tap = branch.indexOf('handleReportTap(from, buttonPayload)');
    expect(tap).toBeGreaterThan(-1);
    expect(tap).toBeLessThan(branch.indexOf("buttonPayload.startsWith('style_')"));
  });
});
