/**
 * The greeting filter must not eat real names. "Salam", "Hola" and "Hi" are
 * greetings, but Salam is also a given name, and Hi-Young is one too. A
 * teacher named Salam used to be asked "I didn't quite catch that" for every
 * plain message, forever, because every reply was read as a name answer and
 * every answer came back empty.
 *
 * The rule (see parseNameReply in feature-registration.service.js):
 * - a greeting is stripped only when a space or comma follows it and either an
 *   introduction ("I am", "I'm", "my name is", "this is", "it's", "call me")
 *   or punctuation then a name follows, or the greeting can only be a greeting
 *   ("Hello Ayesha"). "Salam Karimi" keeps Salam, because Salam is a name;
 * - nothing after "my name is" is ever stripped;
 * - a reply that is only one greeting word is a candidate: Rumi asks whether
 *   it is the name, and takes it when the teacher sends it again.
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

describe('extractFirstName keeps names that look like greetings', () => {
  it.each([
    ['My name is Salam', 'Salam'],
    ['Salam Karimi', 'Salam'],
    ['Hi-Young', 'Hi-Young'],
    ["Hi, I'm Sara", 'Sara'],
    ['Hello, I am Sara', 'Sara'],
    ['hi, I am Ayesha', 'Ayesha'],
    ['Salam, my name is Ali', 'Ali'],
    ['Salam, Ali', 'Ali'],
    ['Hello Ayesha', 'Ayesha'],
    ['Heyward', 'Heyward'],
    ['Ola', 'Ola'],
    ['Ali', 'Ali'],
    ['Hilal', 'Hilal'],
    ['Noor', 'Noor'],
    ['سلام', 'سلام'],
    ['عائشہ', 'عائشہ'],
  ])('"%s" gives %s', (reply, name) => {
    expect(load().extractFirstName(reply)).toBe(name);
  });

  it.each(['null', 'Null', 'undefined', 'None', 'none.'])('"%s" is never a name', (reply) => {
    expect(load().extractFirstName(reply)).toBeNull();
  });
});

describe('parseNameReply', () => {
  it.each([['Salam', 'Salam'], ['salaam', 'Salaam'], ['Hi!', 'Hi'], ['Hola', 'Hola']])(
    'a reply that is only "%s" is a candidate to confirm, not a name yet',
    (reply, candidate) => {
      expect(load().parseNameReply(reply)).toEqual({ candidate });
    },
  );

  it.each(['ok', 'Thanks', 'Assalam o Alaikum', 'null', '/menu'])('"%s" is neither a name nor a candidate', (reply) => {
    expect(load().parseNameReply(reply)).toEqual({});
  });
});
