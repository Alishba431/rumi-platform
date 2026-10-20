#!/usr/bin/env node
/**
 * Import a curriculum page-truth corpus into the textbook tables
 *
 * Why this exists: the test paper feature builds papers from a deployment's
 * own textbooks, and it reads them from three tables —
 *
 *   textbooks        one row per book, scoped UNIQUE on (province, grade, subject)
 *   textbook_toc     the chapters a teacher can pick, with printed page ranges
 *   textbook_pages   the text of every page, keyed by pdf page index
 *
 * The repo's curriculum/ pipeline already produces exactly that knowledge as
 * files (stage 01_page_truth: `_book.json`, `_toc.json`, `pg_###.json` per
 * book), but nothing loaded it into the database. This script is that bridge,
 * so a cloner who has run the pipeline over their own books can offer test
 * papers on them without writing any ingestion code.
 *
 * The CLI argument may be a pipeline project root (containing 01_page_truth/),
 * the 01_page_truth/ folder itself, or a single 01_page_truth/<book>/ folder;
 * every book found is imported.
 *
 * Idempotent: the textbook row is upserted on (province, grade, subject) and
 * that textbook's toc and pages are deleted and replaced, so a re-run yields
 * the same rows, never duplicates. The replace is not transactional (PostgREST
 * has no multi-statement transaction); a failure mid-way leaves the book
 * partially loaded and is fixed by simply re-running.
 *
 * Usage:
 *   node bot/scripts/testpaper/import-curriculum-corpus.js <corpus-dir> [--dry-run]
 *     [--curriculum <key>]   textbook_toc / textbooks curriculum key (default: corpus)
 *     [--province <key>]     the textbooks UNIQUE scope column (default: the curriculum
 *                            key, so two curricula of the same grade+subject are kept
 *                            apart rather than one replacing the other). It is only a
 *                            namespace, not a geography.
 *     [--subject <name>]     override the book's subject (stored lower-cased)
 *     [--grade <n>]          override the book's grade (1-12)
 *
 * Structure: pure readCorpus() / buildRows() and a writeRows() that takes an
 * injected client, so --dry-run and the tests never load the Supabase config
 * (which exits the process when its env vars are missing).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PAGE_TRUTH_DIR = '01_page_truth';
/** Rows per insert request — comfortably under PostgREST's payload limits for page text. */
const BATCH = 200;
/**
 * The upsert options live in a constant rather than inline: the column
 * completeness guard reads the first object literal after `.upsert(` as the
 * row, and would otherwise report `onConflict` as a missing column.
 */
const TEXTBOOK_UPSERT = { onConflict: 'province,grade,subject' };

const DEFAULTS = { curriculum: 'corpus', province: null };

// ── Reading ─────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** A book folder is any folder holding a `_book.json`. */
function isBookDir(dir) {
  return fs.existsSync(path.join(dir, '_book.json'));
}

function bookDirsUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .filter(isBookDir)
    .sort();
}

/**
 * Read every page-truth book under `dir`.
 *
 * @param {string} dir project root, 01_page_truth/, or 01_page_truth/<book>/
 * @returns {Array<{dir: string, book: object, toc: {chapters: object[]}, pages: object[]}>}
 *   pages sorted by pdf_page_index
 */
function readCorpus(dir) {
  let dirs;
  if (isBookDir(dir)) dirs = [dir];
  else if (fs.existsSync(path.join(dir, PAGE_TRUTH_DIR))) dirs = bookDirsUnder(path.join(dir, PAGE_TRUTH_DIR));
  else dirs = bookDirsUnder(dir);

  if (!dirs.length) {
    throw new Error(`no page-truth books found under ${dir} (expected ${PAGE_TRUTH_DIR}/<book>/_book.json)`);
  }

  return dirs.map((bookDir) => {
    const tocFile = path.join(bookDir, '_toc.json');
    const pages = fs.readdirSync(bookDir)
      .filter((f) => /^pg_\d+\.json$/.test(f))
      .map((f) => readJson(path.join(bookDir, f)))
      .sort((a, b) => a.pdf_page_index - b.pdf_page_index);
    return {
      dir: bookDir,
      book: readJson(path.join(bookDir, '_book.json')),
      toc: fs.existsSync(tocFile) ? readJson(tocFile) : { chapters: [] },
      pages,
    };
  });
}

// ── Building rows ───────────────────────────────────────────────────────────

/** Capture-agent annotations ("[blank box]", "(with a '5' crown icon)") are not printed text. */
function stripAnnotations(s) {
  return String(s || '').replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function words(s) {
  return String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

/**
 * The text a test paper is generated from.
 *
 * Decision, from the data: in the sample corpus every exercise's
 * instruction_verbatim is already inside text_verbatim — the only differences
 * are blank markers ("___", "[blank box]") and the capture agent's own notes
 * about icons and layout. So page_content is text_verbatim, and an exercise's
 * instruction is appended only when most of its words are genuinely absent
 * from the page (a capture that put the exercise text only in exercises[]).
 * answer_key is NEVER appended: it is the capture agent's inference, not
 * printed text, and putting answers into the source would leak them into the
 * paper. The full exercises (answers included) still go to the exercises
 * column, where the paper generator can use them deliberately.
 */
function pageContent(page) {
  const text = String(page.text_verbatim || '').trim();
  const onPage = new Set(words(text));
  const extra = [];
  for (const ex of page.exercises || []) {
    const instruction = stripAnnotations(ex && ex.instruction_verbatim);
    const ws = words(instruction);
    if (!ws.length) continue;
    const missing = ws.filter((w) => !onPage.has(w)).length;
    if (missing / ws.length > 0.5) {
      extra.push(instruction);
      for (const w of ws) onPage.add(w);
    }
  }
  return [text, ...extra].filter(Boolean).join('\n\n');
}

/** Digits joined by an arithmetic or comparison sign: "20 + 5", "120 < 192". */
const MATH_RE = /\d\s*[-+×x÷*/=<>]\s*\d/;

function normaliseSubject(subject) {
  return String(subject || '').trim().toLowerCase();
}

/**
 * Turn one book into the rows for the three tables. textbook_id is filled in
 * by writeRows once the textbook row exists.
 *
 * @param {{book: object, toc: {chapters: object[]}, pages: object[]}} corpusBook
 * @param {{curriculum?: string, province?: string, subject?: string, grade?: number}} opts
 * @returns {{textbook: object, toc: object[], pages: object[]}}
 */
function buildRows(corpusBook, opts = {}) {
  const { book, toc = { chapters: [] }, pages: srcPages = [] } = corpusBook;
  const curriculum = opts.curriculum || DEFAULTS.curriculum;
  // The UNIQUE scope follows the curriculum: with one fixed default, importing
  // a second curriculum for the same grade and subject would upsert over the
  // first and replace its chapters and pages.
  const province = opts.province || curriculum;
  const subject = normaliseSubject(opts.subject || book.subject);
  const grade = Number(opts.grade || book.grade);
  if (!subject) throw new Error(`${book.book_stem}: no subject in _book.json — pass --subject`);
  if (!Number.isInteger(grade) || grade < 1 || grade > 12) {
    throw new Error(`${book.book_stem}: grade must be 1-12 (got ${opts.grade || book.grade}) — pass --grade`);
  }
  const offset = Number.isInteger(book.offset) ? book.offset : 0;
  const isMathSubject = /math/.test(subject);

  // Pages: blank pages carry nothing a paper could use, so they are skipped.
  const pages = [];
  const pageChapters = []; // parallel to pages: the chapter number each page belongs to
  for (const p of srcPages) {
    const content = pageContent(p);
    if (!content) continue;
    pages.push({
      pdf_page_index: p.pdf_page_index,
      textbook_page_number: Number.isInteger(p.printed_page_number) ? p.printed_page_number : null,
      page_content: content,
      exercises: Array.isArray(p.exercises) ? p.exercises : [],
      has_math: isMathSubject || MATH_RE.test(content),
      content_length: content.length,
    });
    pageChapters.push(p.chapter && Number.isInteger(p.chapter.number) ? p.chapter : null);
  }

  // The book's last printed page, when the book description says so.
  const printedLast = (book.content_span && Number.isInteger(book.content_span.printed_last_est))
    ? book.content_span.printed_last_est
    : (Number.isInteger(book.total_pdf_pages) ? book.total_pdf_pages - offset : null);
  const printedSeen = pages.map((p) => p.textbook_page_number).filter(Number.isInteger);
  const maxSeen = printedSeen.length ? Math.max(...printedSeen) : null;

  // Chapters from the ToC; a chapter that pages name but the ToC lacks is
  // still importable, with its range taken from its own pages.
  const chapters = (toc.chapters || [])
    .filter((c) => Number.isInteger(c.number))
    .map((c) => ({ number: c.number, title: c.title, start: c.printed_start }))
    .sort((a, b) => a.start - b.start);
  for (const ch of pageChapters) {
    if (ch && !chapters.some((c) => c.number === ch.number)) {
      const own = pages.filter((_, i) => pageChapters[i] && pageChapters[i].number === ch.number)
        .map((p) => p.textbook_page_number).filter(Number.isInteger);
      chapters.push({ number: ch.number, title: ch.title, start: Math.min(...own), end: Math.max(...own) });
    }
  }

  const tocRows = [];
  chapters.forEach((c, i) => {
    const next = chapters.slice(i + 1).find((n) => Number.isInteger(n.start) && n.start > c.start);
    const end = c.end != null ? c.end
      : next ? next.start - 1
        : (printedLast != null ? printedLast : maxSeen);

    // Only chapters with at least one page of text are written: textbook_toc is
    // what a teacher is offered, and a test paper must never be offered for a
    // chapter the deployment has no text for. A page counts towards a chapter
    // by its own chapter tag, or, untagged, by falling inside the page range.
    const hasText = pages.some((p, k) => (pageChapters[k]
      ? pageChapters[k].number === c.number
      : Number.isInteger(p.textbook_page_number) && p.textbook_page_number >= c.start
        && end != null && p.textbook_page_number <= end));
    if (!hasText) return;

    tocRows.push({
      chapter_number: c.number,
      chapter_title: c.title || `Chapter ${c.number}`,
      page_start: Number.isInteger(c.start) ? c.start : null,
      page_end: end != null && Number.isInteger(c.start) ? Math.max(end, c.start) : end,
      curriculum,
      grade,
      subject,
    });
  });

  // Deterministic, so a re-run writes identical rows: the latest capture date.
  const captured = srcPages.map((p) => p.described_at).filter(Boolean).sort();

  return {
    textbook: {
      province,
      curriculum,
      grade,
      subject,
      filename: book.book_stem,
      total_pages: Number.isInteger(book.total_pdf_pages) ? book.total_pdf_pages : null,
      pdf_page_offset: offset,
      ocr_status: 'completed',
      ocr_completed_at: captured.length ? captured[captured.length - 1] : null,
    },
    toc: tocRows,
    pages,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function check(result, what) {
  if (result && result.error) throw new Error(`${what} failed: ${result.error.message}`);
  return result;
}

/**
 * Write one book's rows: upsert the textbook, then delete-and-replace its toc
 * and pages.
 *
 * @param {object} supabase a Supabase client (injected; the tests pass a fake)
 * @param {{textbook: object, toc: object[], pages: object[]}} rows from buildRows
 * @returns {Promise<{textbookId: string, chapters: number, pages: number}>}
 */
async function writeRows(supabase, rows) {
  const { data } = check(
    await supabase.from('textbooks').upsert(rows.textbook, TEXTBOOK_UPSERT).select('id').single(),
    'textbooks upsert',
  );
  const textbookId = data && data.id;
  // Braced on purpose: the column guard scans to the next `{` after `.upsert(`.
  if (!textbookId) { throw new Error('textbooks upsert returned no id'); }

  check(await supabase.from('textbook_toc').delete().eq('textbook_id', textbookId), 'textbook_toc delete');
  check(await supabase.from('textbook_pages').delete().eq('textbook_id', textbookId), 'textbook_pages delete');

  const tocRows = rows.toc.map((r) => ({ textbook_id: textbookId, ...r }));
  const pageRows = rows.pages.map((r) => ({ textbook_id: textbookId, ...r }));
  for (const batch of chunks(tocRows, BATCH)) {
    check(await supabase.from('textbook_toc').insert(batch), 'textbook_toc insert');
  }
  for (const batch of chunks(pageRows, BATCH)) {
    check(await supabase.from('textbook_pages').insert(batch), 'textbook_pages insert');
  }
  // Shorthand keys only, for the same guard (it reads `key:` pairs after `.insert(`).
  const chapters = tocRows.length;
  const pages = pageRows.length;
  return { textbookId, chapters, pages };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { dirs: [], ...DEFAULTS, dryRun: false, subject: null, grade: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--curriculum') out.curriculum = value();
    else if (a === '--province') out.province = value();
    else if (a === '--subject') out.subject = value();
    else if (a === '--grade') out.grade = Number(value());
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else out.dirs.push(a);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.dirs.length) {
    console.log('Usage: import-curriculum-corpus.js <corpus-dir> [--dry-run] [--curriculum k] '
      + '[--province k] [--subject s] [--grade n]');
    return 1;
  }

  const books = args.dirs.flatMap(readCorpus);
  const built = books.map((b) => ({ stem: b.book.book_stem, rows: buildRows(b, args) }));

  const supabase = args.dryRun ? null : require('../../shared/config/supabase');
  let chapters = 0;
  let pages = 0;
  for (const { stem, rows } of built) {
    const t = rows.textbook;
    const line = `${stem}: ${t.curriculum} / ${t.province} / grade ${t.grade} ${t.subject}`
      + ` — ${rows.toc.length} chapter(s), ${rows.pages.length} page(s)`;
    if (args.dryRun) {
      console.log(line);
      for (const c of rows.toc) {
        console.log(`   ch ${c.chapter_number} "${c.chapter_title}" pp ${c.page_start}-${c.page_end}`);
      }
    } else {
      const res = await writeRows(supabase, rows);
      console.log(`${line} (textbook ${res.textbookId})`);
    }
    chapters += rows.toc.length;
    pages += rows.pages.length;
  }
  console.log(`${args.dryRun ? 'Dry run — nothing written. Would write' : 'Wrote'}: `
    + `${built.length} book(s), ${chapters} chapter(s), ${pages} page(s)`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { readCorpus, buildRows, writeRows, parseArgs, main, pageContent };
