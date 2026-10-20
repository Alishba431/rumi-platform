/**
 * paper-renderer — the printable paper and its answer key, as self-contained
 * HTML for the headless browser that prints it.
 *
 * What the source generator decided by SUBJECT ("these subjects are taught
 * right to left") is decided here by the paper's LANGUAGE, because that is what
 * actually sets the direction of the page: an Arabic paper is right to left
 * whatever the subject is called, and an English paper is not.
 *
 * Pure functions, no I/O beyond reading the bundled font files.
 */

const R = require('../../bot/shared/services/testpaper/paper-renderer');

const EXAM = {
  unseen: {
    objective: {
      MCQs: [
        {
          main_question: 'Choose the correct option',
          question: 'Which number comes after 99?',
          options: ['a) 98', 'b) 100', 'c) 101', 'd) 909'],
          marks: 1, lines: 0, answer: 'b) 100',
        },
        {
          main_question: 'Choose the correct option',
          question: 'What is <b>bold</b> & safe?',
          options: ['a) yes', 'b) no'],
          marks: 1, lines: 0, answer: 'a) yes',
        },
      ],
      'True/False': [
        { main_question: 'Write True or False', question: '345 has 3 hundreds.', marks: 1, lines: 0, answer: 'True' },
        { question: 'A removed one.', marks: 5, removed: true, answer: 'False' },
      ],
    },
    subjective: {
      'Short Questions': [
        { main_question: 'Answer the following', question: 'Write 456 in words.', marks: 2, lines: 2 },
      ],
    },
  },
};

describe('renderPaper', () => {
  const html = R.renderPaper({ examJson: EXAM, grade: 2, subject: 'Math', language: 'en', chapterTitle: 'Numbers to 999' });

  it('prints every question, numbered, skipping removed ones', () => {
    expect(html).toContain('<b class="qn">1.</b> Which number comes after 99?');
    expect(html).toContain('<b class="qn">4.</b> Write 456 in words.');
    expect(html).not.toContain('A removed one.');
  });

  it('never prints answers on the paper a child writes on', () => {
    expect(html).not.toContain('Answer:');
    expect(html).not.toContain('b) 100</div><div class="answer"');
  });

  it('escapes model text rather than rendering it as markup', () => {
    expect(html).toContain('What is &lt;b&gt;bold&lt;/b&gt; &amp; safe?');
  });

  it('totals the marks it prints (removed questions excluded)', () => {
    expect(html).toContain('<td class="k">Total Marks</td><td>5</td>');
  });

  it('heads the paper with grade, subject and chapter', () => {
    expect(html).toContain('Grade 2 · Math');
    expect(html).toContain('Numbers to 999');
  });

  it('omits the grade when the source did not say one', () => {
    const noGrade = R.renderPaper({ examJson: EXAM, subject: 'Science', language: 'en' });
    expect(noGrade).not.toContain('Grade undefined');
    expect(noGrade).not.toMatch(/Grade\s*·/);
    expect(noGrade).toContain('Science');
  });

  it('is left to right for an English paper', () => {
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('dir="rtl"');
  });

  it('labels a later version so two printouts can be told apart', () => {
    const v2 = R.renderPaper({ examJson: EXAM, grade: 2, subject: 'Math', language: 'en', version: 2 });
    expect(v2).toContain('Version 2');
    expect(html).not.toContain('Version 1');
  });
});

describe('direction and fonts follow the paper language', () => {
  it.each(['ur', 'ar', 'fa', 'ps', 'sd', 'he'])('%s is right to left', (lang) => {
    expect(R.isRtl(lang)).toBe(true);
    const html = R.renderPaper({ examJson: EXAM, grade: 3, subject: 'Science', language: lang });
    expect(html).toContain(`<html lang="${lang}" dir="rtl">`);
  });

  it.each(['pa-PK', 'bal-PK', 'sd-PK', 'ps-PK'])('the platform code %s is right to left, in a Perso-Arabic face', (lang) => {
    expect(R.isRtl(lang)).toBe(true);
    expect(R.scriptFontFor(lang)).toBeTruthy();
  });

  it.each(['en', 'sw', 'fr', 'hi', 'ta-IN', null])('%s is left to right', (lang) => {
    expect(R.isRtl(lang)).toBe(false);
  });

  it('an Urdu paper embeds the Nastaliq face', () => {
    const html = R.renderPaper({ examJson: EXAM, grade: 3, subject: 'Science', language: 'ur' });
    expect(html).toMatch(/font-family:'PaperScript'[^}]*base64,/);
    expect(R.scriptFontFor('ur')).toMatch(/Nastaliq/);
  });

  it('an Arabic-script paper that is not Urdu gets the Naskh face', () => {
    expect(R.scriptFontFor('ar')).toMatch(/Naskh/);
    expect(R.scriptFontFor('fa')).toMatch(/Naskh/);
  });

  it('a left-to-right paper carries no script face it does not need', () => {
    const html = R.renderPaper({ examJson: EXAM, grade: 3, subject: 'Science', language: 'en' });
    expect(html).not.toContain("font-family:'PaperScript'");
  });

  it('keeps Latin runs (marks, numbers) isolated left to right inside an RTL page', () => {
    const html = R.renderPaper({ examJson: EXAM, grade: 3, subject: 'Science', language: 'ur' });
    expect(html).toMatch(/\.marks, \.num \{ direction: ltr; unicode-bidi: isolate; \}/);
  });
});

describe('renderAnswerKey', () => {
  const key = R.renderAnswerKey({ examJson: EXAM, grade: 2, subject: 'Math', language: 'en' });

  it('is titled as the answer key', () => {
    expect(key).toContain('Answer Key');
  });

  it('numbers match the paper, with the answer beside each question', () => {
    expect(key).toContain('<td class="num">1.</td><td class="qt">Which number comes after 99?</td><td class="ans">b) 100</td>');
    expect(key).toContain('<td class="num">3.</td><td class="qt">345 has 3 hundreds.</td><td class="ans">True</td>');
  });

  it('shows a dash where the model gave no answer, rather than renumbering', () => {
    expect(key).toContain('<td class="num">4.</td><td class="qt">Write 456 in words.</td><td class="ans">—</td>');
  });
});

describe('answer lines', () => {
  it('no lines where there is nothing to write', () => {
    expect(R.answerLinesFor('MCQs', { options: ['a', 'b'] })).toBe(0);
    expect(R.answerLinesFor('Match the Column', { column_a: ['x'] })).toBe(0);
  });
  it('the model\'s own number when it is sane, else the type default', () => {
    expect(R.answerLinesFor('Short Questions', { lines: 5 })).toBe(5);
    expect(R.answerLinesFor('Short Questions', { lines: 99 })).toBe(4);
    expect(R.answerLinesFor('Essay Writing', {})).toBe(10);
  });
});

describe('printing', () => {
  // Found printing real papers: a border drawn on the right edge of the printable
  // area (the marks table, the instructions box) is cropped by Chrome's PDF
  // printer. A 2px inner gutter keeps every border on the page.
  it.each(['renderPaper', 'renderAnswerKey'])('%s keeps an inner gutter so right-hand borders print', (fn) => {
    const html = R[fn]({ examJson: EXAM, grade: 2, subject: 'Math', language: 'en' });
    expect(html).toMatch(/body \{[^}]*padding: 0 2px;/);
  });
});

describe('the paper speaks its own language', () => {
  // Found on a real Urdu paper: the questions were Urdu and the marks header,
  // instructions and section headings were English.
  const ur = R.renderPaper({ examJson: EXAM, grade: 2, subject: 'Math', language: 'ur' });
  const urKey = R.renderAnswerKey({ examJson: EXAM, grade: 2, subject: 'Math', language: 'ur' });

  it('an Urdu paper has Urdu header labels and instructions', () => {
    expect(ur).toContain('رول نمبر');
    expect(ur).toContain('کل نمبر');
    expect(ur).toContain('ہدایات');
    expect(ur).not.toContain('Student Name');
    expect(ur).not.toContain('Read all questions carefully');
  });

  it('section headings and marks are in Urdu', () => {
    expect(ur).toContain('<h3 class="type">کثیر انتخابی سوالات</h3>');
    expect(ur).toContain('[1 نمبر]');
  });

  it('localised labels are laid out right to left', () => {
    expect(ur).toMatch(/table\.marks-header \{[^}]*direction: rtl/);
  });

  it('the Urdu answer key is titled in Urdu', () => {
    expect(urKey).toContain('جوابی کلید');
    expect(urKey).not.toContain('For the teacher.');
  });

  it('a language with no label set keeps English labels, left to right', () => {
    const ar = R.renderPaper({ examJson: EXAM, grade: 2, subject: 'Math', language: 'ar' });
    expect(ar).toContain('Student Name');
    expect(ar).toMatch(/table\.marks-header \{[^}]*direction: ltr/);
  });
});

describe('question numbers in a right-to-left paper', () => {
  // Found on a real Urdu paper: "2." followed by a question starting with the
  // number 56 printed as "56.2". The number is its own isolated run.
  it('every question number is an isolated run', () => {
    const html = R.renderPaper({ examJson: EXAM, grade: 2, subject: 'Math', language: 'ur' });
    expect(html).toContain('<b class="qn">1.</b>');
    expect(html).toMatch(/\.qn \{ direction: ltr; unicode-bidi: isolate; \}/);
  });
});
