'use strict';
/**
 * Object storage (R2) is optional. Without it, a question card or a figure is
 * kept on local disk and the row carries a file:// URL, the same way main
 * keeps a reading report or a voice note: the Baileys, Slack, Discord and
 * Matrix drivers read a file:// URL straight off disk when they send it.
 * Before, every card upload failed, so a quiz with any `$…$` stem could never
 * ship ("CARD_RENDER … R2_ENDPOINT … not set").
 *
 * The real renderCards / renderFigures run; only the screenshot (Playwright),
 * the storage client and the logs are mocked. TEMP_DIR points at a scratch dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-no-r2-'));
jest.mock('../../bot/shared/utils/constants', () => ({
  ...jest.requireActual('../../bot/shared/utils/constants'), TEMP_DIR: mockTmp,
}));
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({
  htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
  htmlToImage: jest.fn(),
}));
// What storage/r2 does on a deployment with no R2_* keys: the client refuses at send time.
jest.mock('../../bot/shared/storage/r2', () => ({
  isR2Configured: jest.fn(() => false),
  uploadBuffer: jest.fn().mockRejectedValue(new Error('R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY not set')),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const { htmlToImage } = require('../../bot/shared/utils/html-to-pdf');
const R2 = require('../../bot/shared/storage/r2');
const Gen = require('../../bot/shared/services/quiz/transcript-quiz-generate.service');

const MATHS_ROW = {
  external_id: 'tq:q1:S1:0', question_text: 'What is $\\frac{1}{2} + \\frac{1}{4}$?',
  option_a: '$\\frac{3}{4}$', option_b: '$\\frac{2}{6}$', option_c: '$\\frac{1}{8}$', correct_option: 'A', media: {},
};
const PNG = Buffer.from('png-bytes-of-the-card');
const localFile = (url) => url.slice('file://'.length);

beforeEach(() => {
  jest.clearAllMocks();
  htmlToImage.mockResolvedValue(PNG);
});
afterAll(() => fs.rmSync(mockTmp, { recursive: true, force: true }));

test('a maths question card is kept on local disk and the row gets a file:// URL', async () => {
  const urls = await Gen.renderCards({ rows: [MATHS_ROW], questions: [{}], language: 'en', teacherId: 't-1', quizId: 'q-1' });
  expect(urls[0]).toMatch(/^file:\/\//);
  expect(localFile(urls[0]).startsWith(mockTmp)).toBe(true);
  expect(fs.readFileSync(localFile(urls[0]))).toEqual(PNG);
  expect(R2.uploadBuffer).not.toHaveBeenCalled();
});

test('a figure is kept on local disk too', async () => {
  const questions = [{ question: 'How much is shaded?', figure: { type: 'fraction_bar', parts: 4, shaded: 3 } }];
  const urls = await Gen.renderFigures({ questions, language: 'en', teacherId: 't-1', quizId: 'q-2' });
  expect(urls[0]).toMatch(/^file:\/\//);
  expect(fs.readFileSync(localFile(urls[0]))).toEqual(PNG);
  expect(R2.uploadBuffer).not.toHaveBeenCalled();
});

test('ids from the row never leave the media folder', async () => {
  const urls = await Gen.renderCards({ rows: [MATHS_ROW], questions: [{}], language: 'en', teacherId: '../../etc', quizId: '../x' });
  const p = path.resolve(localFile(urls[0]));
  expect(p.startsWith(path.join(mockTmp, 'transcript_quizzes') + path.sep)).toBe(true);
});

test('with object storage configured the card still goes to R2', async () => {
  R2.isR2Configured.mockReturnValueOnce(true);
  R2.uploadBuffer.mockResolvedValueOnce('https://r2.example/card1.png');
  const urls = await Gen.renderCards({ rows: [MATHS_ROW], questions: [{}], language: 'en', teacherId: 't-1', quizId: 'q-3' });
  expect(urls[0]).toBe('https://r2.example/card1.png');
  expect(R2.uploadBuffer).toHaveBeenCalledWith(PNG, 'transcript_quizzes/t-1/q-3/card1.png', 'image/png');
});
