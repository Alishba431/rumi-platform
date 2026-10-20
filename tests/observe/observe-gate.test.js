/**
 * /observe trigger gate — pure decision helper (mirrors evaluateHomeworkTrigger).
 *
 * The capability is a channel-neutral switch (OBSERVE_ENABLED), not a
 * Meta Flow id: /observe has to work on every channel, and a deployment with
 * no WhatsApp Business account has no Flow id to set.
 */

const {
  OBSERVE_TRIGGER_RX,
  evaluateObserveTrigger,
  isObserveEnabled,
  isSchoolLeader,
  leaderRoles,
  pickObservationFramework,
  canSelfCoach,
} = require('../../bot/shared/services/observe/observe-gate');

const COACH = (over = {}) => ({
  id: 'coach-uuid-1',
  phone_number: '15550100001',
  role: 'coach',
  preferred_language: 'en',
  preferences: {},
  ...over,
});

describe('observe gate', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.OBSERVE_ENABLED = 'true';
    delete process.env.OBSERVE_LEADER_ROLES;
  });
  afterAll(() => { process.env = saved; });

  describe('OBSERVE_TRIGGER_RX', () => {
    test.each(['/observe', '/OBSERVE', '  /observe  ', '/observe now'])('matches %p', (msg) => {
      expect(OBSERVE_TRIGGER_RX.test(msg.trim())).toBe(true);
    });
    test.each(['observe', '/observer', 'please /observe', '/quiz'])('does not match %p', (msg) => {
      expect(OBSERVE_TRIGGER_RX.test(msg.trim())).toBe(false);
    });
  });

  test('OBSERVE_ENABLED is the only switch — anything but "true" leaves /observe off', () => {
    expect(isObserveEnabled()).toBe(true);
    for (const v of [undefined, '', 'false', '0', 'yes']) {
      if (v === undefined) delete process.env.OBSERVE_ENABLED; else process.env.OBSERVE_ENABLED = v;
      expect(isObserveEnabled()).toBe(false);
      expect(evaluateObserveTrigger({ messageBody: '/observe', user: COACH() })).toEqual({ match: false });
    }
  });

  test('the operator console switch can pause /observe without removing OBSERVE_ENABLED', () => {
    const overrides = require('../../bot/shared/config/feature-overrides');
    overrides.load({ RUMI_FEATURE_OBSERVE: 'off' });
    expect(isObserveEnabled()).toBe(false);
    overrides.load({});
    expect(isObserveEnabled()).toBe(true);
  });

  test('observe is listed in FEATURES, keyed on OBSERVE_ENABLED, so doctor and the console show it', () => {
    const { FEATURES } = require('../../bot/shared/config/feature-availability');
    expect(FEATURES.find((f) => f.id === 'observe')).toMatchObject({ keys: ['OBSERVE_ENABLED'] });
  });

  test('canSelfCoach: a teacher always; of the coach family only OBSERVE_SELF_COACH_ROLES (default the head-teacher family)', () => {
    delete process.env.OBSERVE_SELF_COACH_ROLES;
    expect(canSelfCoach(COACH({ role: null }))).toBe(true);
    expect(canSelfCoach(COACH({ role: 'head_teacher' }))).toBe(true);
    expect(canSelfCoach(COACH({ role: 'teacher' }))).toBe(true);
    expect(canSelfCoach(COACH({ role: 'principal' }))).toBe(true);
    expect(canSelfCoach(COACH({ role: 'coach' }))).toBe(false);
    process.env.OBSERVE_SELF_COACH_ROLES = 'coach';
    expect(canSelfCoach(COACH({ role: 'coach' }))).toBe(true);
    expect(canSelfCoach(COACH({ role: 'principal' }))).toBe(false);
    delete process.env.OBSERVE_SELF_COACH_ROLES;
  });

  test('a non-command message never matches', () => {
    expect(evaluateObserveTrigger({ messageBody: 'hello', user: COACH() })).toEqual({ match: false });
  });

  test('no account → deny_no_user', () => {
    expect(evaluateObserveTrigger({ messageBody: '/observe', user: null }))
      .toEqual({ match: true, action: 'deny_no_user' });
  });

  test('a teacher (no role, or role teacher) → deny_role', () => {
    expect(evaluateObserveTrigger({ messageBody: '/observe', user: COACH({ role: null }) }).action).toBe('deny_role');
    expect(evaluateObserveTrigger({ messageBody: '/observe', user: COACH({ role: 'teacher' }) }).action).toBe('deny_role');
  });

  test('one onboarding for everyone — no A/B arm', () => {
    expect(evaluateObserveTrigger({ messageBody: '/observe', user: COACH() }))
      .toEqual({ match: true, action: 'onboard' });
    expect(evaluateObserveTrigger({ messageBody: '/observe', user: COACH({ preferences: { observe_onboarded: true } }) }))
      .toEqual({ match: true, action: 'capture' });
  });

  test('the role family defaults to the wave\'s one vocabulary: head_teacher (+ read aliases principal, school_leader), coach, supervisor', () => {
    expect(leaderRoles()).toEqual(['head_teacher', 'principal', 'school_leader', 'coach', 'supervisor']);
    for (const role of leaderRoles()) expect(isSchoolLeader(COACH({ role }))).toBe(true);
    expect(isSchoolLeader(COACH({ role: 'teacher' }))).toBe(false);
    expect(isSchoolLeader(null)).toBe(false);
  });

  test('OBSERVE_LEADER_ROLES replaces the family (comma list, trimmed, case-insensitive)', () => {
    process.env.OBSERVE_LEADER_ROLES = ' Mentor , head_teacher ';
    expect(leaderRoles()).toEqual(['mentor', 'head_teacher']);
    expect(isSchoolLeader(COACH({ role: 'mentor' }))).toBe(true);
    expect(isSchoolLeader(COACH({ role: 'Head_Teacher' }))).toBe(true);
    expect(isSchoolLeader(COACH({ role: 'coach' }))).toBe(false);
  });

  test('a leader observation is pinned to the observe pack, never the observer\'s own framework', async () => {
    const selectFramework = jest.fn(async () => ({ name: 'oecd' }));
    const fw = await pickObservationFramework({ observation_type: 'leader_observation', user_id: 'u' }, { selectFramework });
    expect(fw.name).toBe('teach');
    expect(selectFramework).not.toHaveBeenCalled();
    const own = await pickObservationFramework({ observation_type: null, user_id: 'u' }, { selectFramework });
    expect(own.name).toBe('oecd');
    expect(selectFramework).toHaveBeenCalledWith('u');
  });
});
