/**
 * "Reading" from the main menu starts the same assessment /reading test does.
 * It used to call sendFlow() with no flowKind, so a channel without native
 * Flows (Matrix, Baileys) had no way to pick the text-flow equivalent: it
 * returned false and the teacher got "Something went wrong".
 */

describe('menu → Reading', () => {
  function load({ flowSent }) {
    jest.resetModules();
    jest.doMock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    jest.doMock('../../bot/shared/services/llm-client', () => ({ getClient: jest.fn() }));
    jest.doMock('../../bot/shared/database/bot-helpers', () => ({ storeConversation: jest.fn() }));
    jest.doMock('../../bot/shared/services/lesson-planning.service', () => ({}));
    jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
      get: jest.fn(async () => ({ sessionId: 's1' })),
      delete: jest.fn(async () => {}),
    }));
    jest.doMock('../../bot/shared/services/feature-intro.service', () => ({
      sendFirstUseIntroIfNeeded: jest.fn(async () => {}),
      markFeatureUsed: jest.fn(async () => {}),
    }));
    const sendFlow = jest.fn().mockResolvedValue(flowSent);
    const sendMessage = jest.fn().mockResolvedValue(true);
    jest.doMock('../../bot/shared/services/whatsapp.service', () => ({ sendFlow, sendMessage }));
    const MenuService = require('../../bot/shared/services/menu.service');
    return { MenuService, sendFlow, sendMessage };
  }

  it('names the reading-assessment flow kind, so text-only channels can run it', async () => {
    const { MenuService, sendFlow, sendMessage } = load({ flowSent: true });
    await MenuService.handleMenuButtonResponse({ id: 'u1' }, 'mtx:15550100001', 'menu_reading', 'en');
    expect(sendFlow).toHaveBeenCalledWith('mtx:15550100001', expect.objectContaining({
      flowKind: 'reading-assessment',
      flowToken: expect.stringMatching(/^u1:reading-assessment:/),
    }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('says the assessment is not set up, rather than "something went wrong", when no channel can run it', async () => {
    const { MenuService, sendMessage } = load({ flowSent: false });
    await MenuService.handleMenuButtonResponse({ id: 'u1' }, 'mtx:15550100001', 'menu_reading', 'en');
    expect(sendMessage).toHaveBeenCalledWith('mtx:15550100001', expect.stringMatching(/not set up/));
    expect(sendMessage).not.toHaveBeenCalledWith('mtx:15550100001', expect.stringMatching(/Something went wrong/));
  });

  // On Meta, sendFlow also returns false for a passing Graph error. With a
  // Flow id configured, "not set up on this deployment" is wrong and sends the
  // teacher away from something that works on the next try.
  describe('on Meta', () => {
    const META = '15550100001';
    afterEach(() => {
      delete process.env.CHANNEL_DRIVER;
      delete process.env.READING_ASSESSMENT_FLOW_ID;
    });

    it('a Flow id that is configured but failed to send says try again, not "not set up"', async () => {
      process.env.CHANNEL_DRIVER = 'meta';
      process.env.READING_ASSESSMENT_FLOW_ID = '1234567890';
      const { MenuService, sendMessage } = load({ flowSent: false });
      await MenuService.handleMenuButtonResponse({ id: 'u1' }, META, 'menu_reading', 'en');
      expect(sendMessage).toHaveBeenCalledWith(META, expect.stringMatching(/couldn't open .* right now.*try again/i));
      expect(sendMessage).not.toHaveBeenCalledWith(META, expect.stringMatching(/not set up/));
    });

    it('with no Flow id configured, it is still "not set up"', async () => {
      process.env.CHANNEL_DRIVER = 'meta';
      const { MenuService, sendMessage } = load({ flowSent: false });
      await MenuService.handleMenuButtonResponse({ id: 'u1' }, META, 'menu_reading', 'en');
      expect(sendMessage).toHaveBeenCalledWith(META, expect.stringMatching(/not set up/));
    });
  });
});
