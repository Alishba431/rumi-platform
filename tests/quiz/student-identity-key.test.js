'use strict';
/**
 * Who is on this handset, on channels without a phone number (review F-S10).
 *
 * `join <CODE>` is the way in on Slack, Discord and Matrix, and the child's
 * identity row is keyed on the sender. Digits-only keys made two Slack users
 * the same child ("Welcome back, <another child's name>") and a Matrix user no
 * one at all. A phone channel still keys on the digits, as before.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const { normalisePhone } = require('../../bot/shared/services/quiz/student-identity.service');

describe('non-phone channels key on the full prefixed id', () => {
  test('two Slack users are two children', () => {
    const a = normalisePhone('slack:U01AB2CDE3');
    const b = normalisePhone('slack:U01XY2ZZZ3');
    expect(a).toBe('slack:U01AB2CDE3');
    expect(b).toBe('slack:U01XY2ZZZ3');
    expect(a).not.toBe(b);
  });

  test('a Matrix user has a key', () => {
    expect(normalisePhone('matrix:@kid:school.example')).toBe('matrix:@kid:school.example');
  });

  test('a Discord user is not confused with a phone of the same digits', () => {
    expect(normalisePhone('discord:15550100123')).toBe('discord:15550100123');
    expect(normalisePhone('discord:15550100123')).not.toBe(normalisePhone('15550100123'));
  });
});

describe('phone channels key on the digits, unchanged', () => {
  const saved = process.env.DEFAULT_PHONE_COUNTRY_CODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEFAULT_PHONE_COUNTRY_CODE;
    else process.env.DEFAULT_PHONE_COUNTRY_CODE = saved;
  });

  test.each([
    ['15550100123', '15550100123'],
    ['+1 555 010 0123', '15550100123'],
    ['0015550100123', '15550100123'],
    ['whatsapp:+15550100123', '15550100123'],
    ['15550100123@s.whatsapp.net', '15550100123'],
  ])('%s → %s', (raw, key) => {
    expect(normalisePhone(raw)).toBe(key);
  });

  test('a trunk 0 takes the deployment country code', () => {
    process.env.DEFAULT_PHONE_COUNTRY_CODE = '1';
    expect(normalisePhone('05550100123')).toBe('15550100123');
  });

  test('blank is blank', () => {
    expect(normalisePhone('')).toBe('');
    expect(normalisePhone(null)).toBe('');
  });
});
