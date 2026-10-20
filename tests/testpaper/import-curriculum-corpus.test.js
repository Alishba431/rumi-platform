/**
 * Corpus importer: curriculum page-truth -> textbooks / textbook_toc /
 * textbook_pages.
 *
 * The test paper feature builds papers from whatever is in those three tables,
 * so the importer is the only bridge between a deployment's own textbooks and
 * the feature. The fixture is the real sample the curriculum pipeline ships
 * (one book, chapter 1 page-truthed, chapters 2-15 known only from the ToC),
 * which exercises the interesting rule: a chapter with no captured text must
 * never reach textbook_toc, or a teacher could be offered a paper on it.
 *
 * Pure functions are tested directly; the writer runs against a small fake
 * client that records every call, so no database or env is needed.
 */

const path = require('path');

const {
  readCorpus,
  buildRows,
  writeRows,
  parseArgs,
} = require('../../bot/scripts/testpaper/import-curriculum-corpus');

const SAMPLE_ROOT = path.join(__dirname, '../../curriculum/sample/grade_2_math_ch1/expected');
const SAMPLE_BOOK = path.join(SAMPLE_ROOT, '01_page_truth/grade_2_math');

/**
 * A fake Supabase client: every from(table) returns a chainable builder that
 * records its operations and resolves like PostgREST ({ data, error }).
 */
function fakeSupabase({ textbookId = 'tb-1', failOn = null } = {}) {
  const calls = [];
  const client = {
    calls,
    from: jest.fn((table) => {
      const call = { table, ops: [] };
      calls.push(call);
      const builder = {};
      for (const op of ['upsert', 'insert', 'delete', 'eq', 'select', 'single']) {
        builder[op] = (...args) => { call.ops.push({ op, args }); return builder; };
      }
      builder.then = (resolve, reject) => {
        const first = call.ops[0] && call.ops[0].op;
        const error = failOn && failOn.table === table && failOn.op === first
          ? { message: `${table} ${first} refused` } : null;
        const data = !error && table === 'textbooks' ? { id: textbookId } : null;
        return Promise.resolve({ data, error }).then(resolve, reject);
      };
      return builder;
    }),
  };
  return client;
}

describe('readCorpus', () => {
  it('reads a single book folder (01_page_truth/<book>)', () => {
    const books = readCorpus(SAMPLE_BOOK);
    expect(books).toHaveLength(1);
    expect(books[0].book.book_stem).toBe('grade_2_math');
    expect(books[0].toc.chapters).toHaveLength(15);
    expect(books[0].pages).toHaveLength(31);
    // Sorted by pdf page, so downstream ranges are stable.
    expect(books[0].pages[0].pdf_page_index).toBe(6);
    expect(books[0].pages[30].pdf_page_index).toBe(36);
  });

  it('also accepts a project root containing 01_page_truth/', () => {
    const books = readCorpus(SAMPLE_ROOT);
    expect(books.map((b) => b.book.book_stem)).toEqual(['grade_2_math']);
  });

  it('also accepts the 01_page_truth folder itself', () => {
    const books = readCorpus(path.join(SAMPLE_ROOT, '01_page_truth'));
    expect(books).toHaveLength(1);
  });

  it('throws a clear error for a folder with no books', () => {
    expect(() => readCorpus(__dirname)).toThrow(/no page-truth books/i);
  });
});

describe('buildRows', () => {
  const [sample] = readCorpus(SAMPLE_BOOK);
  const rows = buildRows(sample, {});

  it('builds the textbook row on the UNIQUE (province, grade, subject) scope', () => {
    expect(rows.textbook).toMatchObject({
      province: 'corpus',
      curriculum: 'corpus',
      grade: 2,
      subject: 'math',
      filename: 'grade_2_math',
      total_pages: 305,
      pdf_page_offset: 5,
      ocr_status: 'completed',
    });
  });

  it('never copies the publisher metadata into the textbook or toc rows', () => {
    // (Page text is the book's own printed words and is kept verbatim; only
    // the _book.json publisher field is metadata the importer must not carry.)
    const publisher = sample.book.publisher;
    expect(publisher).toBeTruthy();
    expect(JSON.stringify([rows.textbook, rows.toc])).not.toContain(publisher);
  });

  it('writes only chapters that have page text — chapter 1, printed pages 1-31', () => {
    expect(rows.toc).toHaveLength(1);
    expect(rows.toc[0]).toEqual({
      chapter_number: 1,
      chapter_title: 'Numberland Adventures: Up to 999',
      page_start: 1,
      page_end: 31, // next chapter starts on printed page 32
      curriculum: 'corpus',
      grade: 2,
      subject: 'math',
    });
  });

  it('maps every page with its printed number and non-empty content', () => {
    expect(rows.pages).toHaveLength(31);
    for (const p of rows.pages) {
      expect(p.textbook_page_number).toBe(p.pdf_page_index - 5);
      expect(p.page_content.length).toBeGreaterThan(0);
      expect(p.content_length).toBe(p.page_content.length);
      expect(Array.isArray(p.exercises)).toBe(true);
    }
    const opener = rows.pages.find((p) => p.pdf_page_index === 6);
    expect(opener.textbook_page_number).toBe(1);
    expect(opener.page_content).toMatch(/^1 Numberland Adventures/);
  });

  it('keeps page_content to the printed text when exercises only repeat it', () => {
    const src = sample.pages.find((p) => p.pdf_page_index === 17);
    const row = rows.pages.find((p) => p.pdf_page_index === 17);
    expect(row.page_content).toBe(src.text_verbatim);
    expect(row.exercises).toHaveLength(src.exercises.length);
    expect(row.has_math).toBe(true);
  });

  it('appends exercise text the page text is missing, but never answer keys', () => {
    const synthetic = {
      book: { book_stem: 'b', subject: 'Science', grade: 4, offset: 0 },
      toc: { chapters: [{ number: 1, title: 'Plants', printed_start: 1 }] },
      pages: [{
        pdf_page_index: 1, printed_page_number: 1, chapter: { number: 1, title: 'Plants' },
        text_verbatim: 'Plants need water.',
        exercises: [
          { instruction_verbatim: 'Plants need water.', answer_key: 'SECRET-1' },
          { instruction_verbatim: 'Name three parts of a flower. [blank lines]', answer_key: 'SECRET-2' },
        ],
      }],
    };
    const [page] = buildRows(synthetic, {}).pages;
    expect(page.page_content).toBe('Plants need water.\n\nName three parts of a flower.');
    expect(page.page_content).not.toMatch(/SECRET/);
  });

  it('drops pages and chapters with no text at all, and ends the last chapter at the book end', () => {
    const synthetic = {
      book: { book_stem: 'b', subject: 'English', grade: 3, offset: 2, total_pdf_pages: 22 },
      toc: { chapters: [
        { number: 1, title: 'One', printed_start: 1 },
        { number: 2, title: 'Two', printed_start: 5 },
        { number: 3, title: 'Three', printed_start: 9 },
      ] },
      pages: [
        { pdf_page_index: 3, printed_page_number: 1, chapter: { number: 1 }, text_verbatim: '   ', exercises: [] },
        { pdf_page_index: 11, printed_page_number: 9, chapter: { number: 3 }, text_verbatim: 'A story.' },
      ],
    };
    const built = buildRows(synthetic, {});
    expect(built.pages.map((p) => p.pdf_page_index)).toEqual([11]);
    expect(built.toc).toEqual([expect.objectContaining({ chapter_number: 3, page_start: 9, page_end: 20 })]);
  });

  it('two curricula of the same grade and subject are kept apart, not one replacing the other', () => {
    const a = buildRows(sample, { curriculum: 'board_a' }).textbook;
    const b = buildRows(sample, { curriculum: 'board_b' }).textbook;
    // textbooks is UNIQUE (province, grade, subject): the scope follows the curriculum unless --province is given.
    expect([a.province, a.grade, a.subject]).not.toEqual([b.province, b.grade, b.subject]);
    expect(a).toMatchObject({ curriculum: 'board_a', province: 'board_a' });
  });

  it('honours --curriculum/--province/--subject/--grade overrides', () => {
    const built = buildRows(sample, { curriculum: 'my_board', province: 'north', subject: 'Mathematics', grade: 3 });
    expect(built.textbook).toMatchObject({ curriculum: 'my_board', province: 'north', subject: 'mathematics', grade: 3 });
    expect(built.toc[0]).toMatchObject({ curriculum: 'my_board', subject: 'mathematics', grade: 3 });
  });
});

describe('writeRows', () => {
  const [sample] = readCorpus(SAMPLE_BOOK);
  const rows = buildRows(sample, {});

  it('upserts the textbook, then deletes and replaces its toc and pages', async () => {
    const supabase = fakeSupabase();
    const result = await writeRows(supabase, rows);

    expect(result).toEqual({ textbookId: 'tb-1', chapters: 1, pages: 31 });
    const seq = supabase.calls.map((c) => `${c.table}.${c.ops[0].op}`);
    expect(seq.slice(0, 3)).toEqual(['textbooks.upsert', 'textbook_toc.delete', 'textbook_pages.delete']);
    expect(seq.slice(3).every((s) => s === 'textbook_toc.insert' || s === 'textbook_pages.insert')).toBe(true);

    const upsert = supabase.calls[0].ops[0];
    expect(upsert.args[1]).toEqual({ onConflict: 'province,grade,subject' });

    for (const del of supabase.calls.slice(1, 3)) {
      expect(del.ops[1]).toEqual({ op: 'eq', args: ['textbook_id', 'tb-1'] });
    }

    const inserted = (table) => supabase.calls
      .filter((c) => c.table === table && c.ops[0].op === 'insert')
      .flatMap((c) => c.ops[0].args[0]);
    const toc = inserted('textbook_toc');
    const pages = inserted('textbook_pages');
    expect(toc).toHaveLength(1);
    expect(pages).toHaveLength(31);
    expect([...toc, ...pages].every((r) => r.textbook_id === 'tb-1')).toBe(true);
  });

  it('a re-run writes exactly the same rows (idempotent)', async () => {
    const a = fakeSupabase();
    const b = fakeSupabase();
    await writeRows(a, rows);
    await writeRows(b, buildRows(readCorpus(SAMPLE_BOOK)[0], {}));
    expect(JSON.stringify(b.calls)).toBe(JSON.stringify(a.calls));
  });

  it('stops with a clear error when a write fails', async () => {
    const supabase = fakeSupabase({ failOn: { table: 'textbook_toc', op: 'delete' } });
    await expect(writeRows(supabase, rows)).rejects.toThrow(/textbook_toc delete refused/);
  });
});

describe('parseArgs', () => {
  it('reads the folder and flags with their defaults', () => {
    expect(parseArgs(['some/dir'])).toEqual({
      dirs: ['some/dir'], curriculum: 'corpus', province: null, dryRun: false, subject: null, grade: null,
    });
    expect(parseArgs(['d', '--dry-run', '--curriculum', 'k', '--province', 'p', '--subject', 'Math', '--grade', '4']))
      .toEqual({ dirs: ['d'], curriculum: 'k', province: 'p', dryRun: true, subject: 'Math', grade: 4 });
  });
});
