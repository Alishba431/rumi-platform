/**
 * When Rumi is waiting for a teacher's name, the next message is read as the
 * name. A greeting ("Hi") used to become the name, so reports later said
 * "Teacher: Hi null". A bare greeting or an acknowledgement is not a name:
 * Rumi asks again. A greeting in front of a name is stripped.
 */

function load() {
  jest.resetModules();
  jest.doMock('uuid', () => ({ v4: () => 'test-uuid' }), { virtual: true });
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn(), sendAudio: jest.fn() }));
  jest.doMock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
  jest.doMock('../../bot/shared/services/audio.service', () => ({}));
  jest.doMock('../../bot/shared/utils/constants', () => ({ TEMP_DIR: '/tmp' }));
  return require('../../bot/shared/services/feature-registration.service');
}

describe('extractFirstName', () => {
  it.each(['Hi', 'hello', 'Hey!', 'Salam', 'Assalam o Alaikum', 'ok', 'Yes', 'thanks', 'Good morning'])(
    '"%s" is not a name',
    (reply) => {
      expect(load().extractFirstName(reply)).toBeNull();
    },
  );

  it('a command is not a name (the command runs; the name is asked for again later)', () => {
    expect(load().extractFirstName('/menu')).toBeNull();
  });

  it.each([
    ['Hi, I am Sara', 'Sara'],
    ['Hello my name is Bilal', 'Bilal'],
    ['Zara', 'Zara'],
    ['call me Zara', 'Zara'],
  ])('"%s" gives %s', (reply, name) => {
    expect(load().extractFirstName(reply)).toBe(name);
  });
});

describe('displayName', () => {
  it('never renders a missing part as "null" or "undefined"', () => {
    const { displayName } = require('../../bot/shared/utils/display-name');
    expect(displayName({ first_name: 'Sara', last_name: null })).toBe('Sara');
    expect(displayName({ first_name: 'Sara', last_name: 'Khan' })).toBe('Sara Khan');
    expect(displayName({ first_name: null, last_name: null })).toBe('Teacher');
    expect(displayName(null, 'Unknown')).toBe('Unknown');
    expect(displayName({ first_name: 'Sara', last_name: 'Khan' }, 'Teacher', { firstOnly: true })).toBe('Sara');
  });
});

describe('call sites use displayName', () => {
  const fs = require('fs');
  const path = require('path');
  it.each([
    'bot/shared/services/coaching/report-generator.service.js',
    'bot/shared/services/reading/analysis.service.js',
    'bot/workers/stale-session.worker.js',
  ])('%s builds no name from raw first_name/last_name', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
    expect(src).not.toMatch(/\$\{[^}]*first_name\}/);
  });
});
