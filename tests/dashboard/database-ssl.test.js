/**
 * SUPABASE_DB_SSL: the dashboard and portal talk to Postgres directly, and the
 * pool always asked for SSL, so against the laptop-local stack (plain
 * Postgres, no SSL) every dashboard and portal request failed with "The
 * server does not support SSL connections". Hosted Supabase keeps SSL.
 */

describe('dashboard Postgres pool SSL', () => {
  const SAVED = { ...process.env };
  afterEach(() => { process.env = { ...SAVED }; jest.resetModules(); });

  function poolConfig(env) {
    jest.resetModules();
    Object.assign(process.env, env);
    const configs = [];
    jest.doMock('pg', () => ({ Pool: jest.fn(function Pool(cfg) { configs.push(cfg); this.on = jest.fn(); }) }), { virtual: true });
    jest.doMock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
    jest.useFakeTimers();
    require('../../dashboard/config/database');
    jest.useRealTimers();
    return configs[0];
  }

  it('keeps SSL by default (hosted Supabase)', () => {
    delete process.env.SUPABASE_DB_SSL;
    expect(poolConfig({}).ssl).toEqual({ rejectUnauthorized: false });
  });

  it('turns SSL off with SUPABASE_DB_SSL=off (the local stack)', () => {
    expect(poolConfig({ SUPABASE_DB_SSL: 'off' }).ssl).toBe(false);
  });
});
