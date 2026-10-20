'use strict';
/**
 * Every sentence the /testpaper conversation says, in one place, per chat
 * language. English is the fallback for any language without an entry.
 *
 * Urdu copy avoids a gendered first person for the bot: Urdu verbs inflect for
 * the speaker's gender ("بنا رہا ہوں" / "بنا رہی ہوں"), so sentences are passive
 * or about the paper instead ("پرچہ بنایا جا رہا ہے").
 *
 * Each value is a string or a function of named parameters. `t()` resolves one.
 */

const STRINGS = {
  en: {
    notReady: 'Test papers are not switched on for this deployment yet. Type /menu to see what else I can do.',
    noAccount: 'Please send me a message first so I can set up your account, then try /testpaper again.',
    chooseSourceHeader: '📝 Test paper',
    chooseSourceBody: 'What should the paper cover? Pick the material it is built from.',
    chooseSourceButton: 'Choose',
    sourceTextbook: ({ grade, subject }) => `${grade ? `Grade ${grade} · ` : ''}${subject}`,
    sourceTextbookHint: ({ chapters, curriculum }) => [`${chapters} chapter${chapters === 1 ? '' : 's'}`, curriculum].filter(Boolean).join(' · '),
    sourceAllBooks: ({ count }) => `Textbooks (${count})`,
    sourceAllBooksHint: 'Pick a book from a numbered list',
    pickBookText: ({ list, example }) => `📖 *Textbooks*\n\n${list}\n\nReply with the number of the book. To see fewer, name a subject and grade, like */testpaper ${example}*.`,
    pickBookGroupText: ({ list, by, example }) => `📖 *Textbooks* — which ${by === 'grade' ? 'grade' : 'subject'}?\n\n${list}\n\nReply with a number. Next time you can name both, like */testpaper ${example}*.`,
    bookGroupRow: ({ label, count }) => `${label} (${count} book${count === 1 ? '' : 's'})`,
    sourceLessonPlans: ({ count }) => `My lesson plans (${count})`,
    sourceUpload: 'Send a chapter',
    sourceUploadHint: 'PDF, Word or text',
    myPapers: 'My papers',
    noSource: ({ subject }) => `I don't have any material${subject ? ` for *${subject}*` : ''} to build a test paper from yet — no lesson plans and no textbook chapters${subject ? ' on that subject' : ''}.\n\nA paper has to come from what your class is learning, so I won't make one up. You can:\n• send me the chapter as a PDF, a Word file or text, and I'll build the paper from it\n• make a lesson plan first, then come back to /testpaper`,
    sendChapter: 'Send me the chapter as a PDF, a Word file or a text file — or paste its text here. The paper will be built only from what you send.',
    pickChaptersHeader: ({ book }) => `📖 ${book}`,
    pickChaptersBody: 'Which chapter? For a unit test, reply with several numbers like *1,2,3* or a range like *1-4*.',
    pickChaptersText: ({ book, list }) => `📖 *${book}*\n\n${list}\n\nReply with a chapter number, several (*1,3*), a range (*1-4*) or *all* for a whole-unit paper.`,
    allChapters: 'All of them (whole unit)',
    pickLessonsHeader: '📚 My lesson plans',
    pickLessonsBody: 'Which lesson? To cover several, reply with numbers like *1,2*.',
    pickLessonsText: ({ list }) => `📚 *My lesson plans*\n\n${list}\n\nReply with a number, several (*1,3*) or *all*.`,
    allLessons: 'All of these',
    pickAgain: 'Reply with the numbers from the list (like *1* or *1,3*), *all*, or *cancel*.',
    pickMixHeader: '🧮 How big a paper?',
    pickMixBody: 'Pick a size, or type your own mix, e.g. *5 MCQs, 3 true/false, 2 short questions*.',
    mixQuick: 'Quick check · 10 Qs',
    mixQuickHint: 'objective only, quick to mark',
    mixStandard: 'Standard · 20 Qs',
    mixStandardHint: 'a balanced mix',
    mixFull: 'Full paper · 30 Qs',
    mixFullHint: 'with longer answers',
    pickLanguageHeader: '🌐 Paper language',
    pickLanguageBody: 'Which language should the paper be written in?',
    uploadRead: ({ chars }) => `Got it — about ${chars.toLocaleString('en')} characters of text to build the paper from.`,
    uploadTooShort: 'I could not find enough text in that file to build a paper from. If it is a scan or a photo, please send the chapter as text, a Word file or a PDF with selectable text.',
    uploadUnsupported: 'Please send the chapter as a PDF, a Word file or plain text.',
    uploadFailed: 'Sorry, I could not open that file. Please try sending it again.',
    insufficient: ({ what, reason }) => `I can't build a fair paper from ${what} — ${reason || 'there is not enough text in it'}.\n\nI won't make up questions about things it doesn't teach. You can send me the chapter as a PDF, a Word file or text instead, or pick other material with /testpaper.`,
    insufficientLessons: ({ skipped }) => `Those lesson plans were saved without their content${skipped && skipped.length ? ` (${skipped.join('; ')})` : ''}, so there is nothing to build a paper from.\n\nSend me the chapter as a PDF, a Word file or text instead, or pick other material with /testpaper.`,
    making: ({ label, count, language }) => `📝 Making your test paper — ${label} · ${count} questions · ${language}.\n\nIt takes about a minute; the paper and its answer key will arrive here.`,
    revising: ({ version }) => `✏️ Making version ${version} of your paper. It takes about a minute.`,
    paperCaption: ({ title, version }) => `📝 ${title}${version > 1 ? ` (version ${version})` : ''}`,
    keyCaption: ({ title }) => `🔑 Answer key — ${title}`,
    afterDelivery: ({ count, marks }) => `Your paper has ${count} questions${marks ? ` worth ${marks} marks` : ''}. Want to change anything?`,
    editButton: '✏️ Edit this paper',
    newButton: '➕ New paper',
    papersButton: '📂 My papers',
    askEdit: 'What should change? For example:\n• *make it easier*\n• *add 5 MCQs about rounding*\n• *remove question 4*\n• *give question 6 three marks*\n\nA new version is made; the current one stays as it is.',
    editTooShort: 'Tell me what to change in a few words — for example *make it easier* or *add 5 MCQs about rounding*. Or reply *cancel*.',
    editUnchanged: ({ note }) => `I left the paper as it was${note ? ` — ${note}` : ''}. You can ask for a different change, or start a new paper with /testpaper.`,
    noPapers: 'You have no test papers yet. Type /testpaper to make one.',
    myPapersHeader: '📂 My papers',
    myPapersBody: 'Pick one to get it again (the latest version).',
    paperRow: ({ title, version }) => `${title}${version > 1 ? ` · v${version}` : ''}`,
    paperGone: 'I could not find that paper. Type /testpaper to make a new one.',
    cancelled: 'Okay — no paper made. Type /testpaper whenever you want one.',
    pdfUnavailable: 'The paper is ready, but this deployment cannot print PDFs yet (a Chromium browser is needed). Please ask your administrator to set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.',
    failed: 'Sorry, the paper could not be made just now. Please try /testpaper again in a few minutes.',
    sendFailed: 'Your paper is ready, but it could not be sent just now. Type /mypapers to get it again.',
    failedTooLong: 'That was too much for one paper. Please try again with fewer questions.',
    failedQueue: 'Sorry, I could not start making your paper. Please try /testpaper again.',
  },
  ur: {
    notReady: 'اس سسٹم پر ابھی ٹیسٹ پیپر کی سہولت چالو نہیں ہے۔ دوسری سہولیات دیکھنے کے لیے /menu لکھیں۔',
    chooseSourceHeader: '📝 ٹیسٹ پیپر',
    chooseSourceBody: 'پرچہ کس مواد سے بنایا جائے؟ مواد منتخب کریں۔',
    chooseSourceButton: 'منتخب کریں',
    sourceLessonPlans: ({ count }) => `میرے لیسن پلان (${count})`,
    sourceAllBooks: ({ count }) => `نصابی کتابیں (${count})`,
    sourceAllBooksHint: 'نمبر والی فہرست سے کتاب منتخب کریں',
    pickBookText: ({ list, example }) => `📖 *نصابی کتابیں*\n\n${list}\n\nکتاب کا نمبر لکھیں۔ کم کتابیں دیکھنے کے لیے مضمون اور جماعت لکھیں، جیسے */testpaper ${example}*۔`,
    pickBookGroupText: ({ list, by, example }) => `📖 *نصابی کتابیں* — ${by === 'grade' ? 'کون سی جماعت؟' : 'کون سا مضمون؟'}\n\n${list}\n\nنمبر لکھیں۔ اگلی بار دونوں لکھ سکتے ہیں، جیسے */testpaper ${example}*۔`,
    bookGroupRow: ({ label, count }) => `${label} (${count} کتابیں)`,
    sourceUpload: 'باب بھیجیں',
    sourceUploadHint: 'PDF، Word یا متن',
    myPapers: 'میرے پرچے',
    noSource: ({ subject }) => `ابھی ${subject ? `*${subject}* کے لیے ` : ''}کوئی مواد موجود نہیں جس سے ٹیسٹ پیپر بنایا جا سکے — نہ لیسن پلان، نہ نصابی کتاب کا کوئی باب۔\n\nپرچہ وہیں سے بنتا ہے جو آپ کی کلاس پڑھ رہی ہے، اس لیے فرضی پرچہ نہیں بنایا جائے گا۔ آپ:\n• باب PDF، Word فائل یا متن کی صورت میں بھیج دیں، پرچہ اسی سے بنے گا\n• یا پہلے لیسن پلان بنائیں، پھر /testpaper لکھیں`,
    sendChapter: 'باب PDF، Word فائل یا ٹیکسٹ فائل میں بھیجیں — یا اس کا متن یہاں لکھ دیں۔ پرچہ صرف اسی مواد سے بنے گا۔',
    pickChaptersBody: 'کون سا باب؟ یونٹ ٹیسٹ کے لیے کئی نمبر لکھیں جیسے *1,2,3* یا *1-4*۔',
    pickChaptersText: ({ book, list }) => `📖 *${book}*\n\n${list}\n\nباب کا نمبر لکھیں، کئی نمبر (*1,3*)، حد (*1-4*) یا پورے یونٹ کے لیے *all*۔`,
    allChapters: 'سب ابواب (پورا یونٹ)',
    pickLessonsBody: 'کون سا سبق؟ کئی کے لیے نمبر لکھیں جیسے *1,2*۔',
    allLessons: 'یہ سب',
    pickAgain: 'فہرست میں سے نمبر لکھیں (جیسے *1* یا *1,3*)، *all* یا *cancel*۔',
    pickMixHeader: '🧮 پرچہ کتنا بڑا ہو؟',
    pickMixBody: 'سائز منتخب کریں، یا اپنی ترتیب لکھیں، مثلاً *5 MCQs, 3 true/false, 2 short questions*۔',
    pickLanguageHeader: '🌐 پرچے کی زبان',
    pickLanguageBody: 'پرچہ کس زبان میں ہو؟',
    making: ({ label, count, language }) => `📝 آپ کا ٹیسٹ پیپر بنایا جا رہا ہے — ${label} · ${count} سوالات · ${language}۔\n\nتقریباً ایک منٹ لگے گا؛ پرچہ اور جوابی کلید یہیں آ جائیں گے۔`,
    revising: ({ version }) => `✏️ آپ کے پرچے کا ورژن ${version} بنایا جا رہا ہے۔ تقریباً ایک منٹ لگے گا۔`,
    afterDelivery: ({ count, marks }) => `آپ کے پرچے میں ${count} سوالات ہیں${marks ? ` (کل ${marks} نمبر)` : ''}۔ کچھ تبدیل کرنا ہے؟`,
    editButton: '✏️ پرچہ تبدیل کریں',
    newButton: '➕ نیا پرچہ',
    papersButton: '📂 میرے پرچے',
    askEdit: 'کیا تبدیل کرنا ہے؟ مثلاً:\n• *آسان کر دیں*\n• *5 MCQs اور شامل کریں*\n• *سوال 4 نکال دیں*\n\nنیا ورژن بنے گا؛ موجودہ پرچہ ویسا ہی رہے گا۔',
    noPapers: 'ابھی آپ کا کوئی ٹیسٹ پیپر نہیں۔ بنانے کے لیے /testpaper لکھیں۔',
    cancelled: 'ٹھیک ہے — کوئی پرچہ نہیں بنایا گیا۔ جب چاہیں /testpaper لکھیں۔',
    failed: 'معذرت، ابھی پرچہ نہیں بن سکا۔ چند منٹ بعد دوبارہ /testpaper لکھیں۔',
    sendFailed: 'پرچہ تیار ہے، مگر ابھی بھیجا نہیں جا سکا۔ دوبارہ حاصل کرنے کے لیے /mypapers لکھیں۔',
  },
};

function _base(language) {
  return String(language || 'en').split(/[-_]/)[0].toLowerCase();
}

/** One sentence for this chat language (English when it has no entry). */
function t(key, language = 'en', params = {}) {
  const table = STRINGS[language] || STRINGS[_base(language)] || STRINGS.en;
  const value = table[key] !== undefined ? table[key] : STRINGS.en[key];
  if (value === undefined) return key;
  return typeof value === 'function' ? value(params) : value;
}

module.exports = { t, STRINGS };
