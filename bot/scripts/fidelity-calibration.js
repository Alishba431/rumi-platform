#!/usr/bin/env node
/**
 * Lesson-plan fidelity calibration check.
 *
 * Runs the REAL extractor and grader (OpenRouter, the models LP_FIDELITY_MODEL / LP_FIDELITY_EXTRACT_MODEL select)
 * over the fictional fixture set in tests/fixtures/fidelity/ and checks each case's score against its expected range:
 * a plan fully followed, half followed, an equivalent substitution, a different lesson, and a transcript with no
 * timestamps. Run it after ANY change to the grader or extractor prompt, or before switching the default model.
 *
 *   node bot/scripts/fidelity-calibration.js [--repeats 3] [--out results.json] [--fixtures <dir>]
 *
 * Needs OPENROUTER_API_KEY (read from the repo-root .env). Costs a few cents per case per repeat.
 * Exit code 0 when every case lands in range on every repeat, 1 otherwise.
 */
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { computeLpFidelity } = require('../shared/services/coaching/fidelity/fidelity-orchestrator');
const { extractUploadedLp } = require('../shared/services/coaching/fidelity/lp-upload-extractor');
const { fidelityModel } = require('../shared/services/coaching/fidelity/fidelity-analyzer');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function inRange(result, expected) {
  if (expected.null) return result.fidelity_pct == null;
  if (result.fidelity_pct == null) return false;
  const pct = result.fidelity_pct;
  const okRange = pct >= expected.fidelity_pct_min && pct <= expected.fidelity_pct_max;
  const okNote = !expected.note || (result.moderators && result.moderators.note === expected.note);
  return okRange && okNote;
}

async function main() {
  const dir = path.resolve(arg('fixtures', path.resolve(__dirname, '../../tests/fixtures/fidelity')));
  const repeats = Math.max(1, Number(arg('repeats', 1)) || 1);
  const out = arg('out', null);
  const cases = JSON.parse(fs.readFileSync(path.join(dir, 'ground_truth.json'), 'utf8'));
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

  // One extraction per plan: the move list is the denominator, so every case graded against the same plan should be
  // graded against the same moves.
  const extracted = new Map();
  const extractPlanMoves = async (text, opts) => {
    if (!extracted.has(text)) extracted.set(text, await extractUploadedLp(text, opts));
    return extracted.get(text);
  };

  const rows = [];
  for (const c of cases) {
    for (let r = 1; r <= repeats; r += 1) {
      const started = Date.now();
      const result = await computeLpFidelity(
        { planText: read(c.plan), source: 'uploaded', transcript: read(c.transcript), runs: 1 },
        { extractPlanMoves },
      );
      const row = {
        case: c.case,
        repeat: r,
        status: result && result.status,
        fidelity_pct: result ? result.fidelity_pct : null,
        band: result ? result.band : null,
        note: result && result.moderators ? result.moderators.note || null : null,
        unusable_guard: result ? result.unusable_guard || null : null,
        moves: result && Array.isArray(result.moves) ? result.moves.length : 0,
        verdicts: result && Array.isArray(result.moves) ? result.moves.map((m) => `${m.move_id}:${m.verdict}`) : [],
        model: result ? result.model : null,
        cause: result ? result.cause || null : null,
        expected: c.expected,
        pass: !!result && result.status === 'ok' && inRange(result, c.expected),
        seconds: Math.round((Date.now() - started) / 100) / 10,
      };
      rows.push(row);
      const shown = row.fidelity_pct == null ? 'null' : `${row.fidelity_pct}%`;
      console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${c.case.padEnd(22)} #${r}  ${String(row.status).padEnd(12)} ${shown.padEnd(7)} ${String(row.band || '-').padEnd(8)} note=${row.note || '-'}  ${row.seconds}s`);
    }
  }

  const passed = rows.filter((r) => r.pass).length;
  console.log(`\n${passed}/${rows.length} gradings in range · grader ${fidelityModel()} · extractor ${process.env.LP_FIDELITY_EXTRACT_MODEL || fidelityModel()}`);
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ ran_at: new Date().toISOString(), grader: fidelityModel(), extractor: process.env.LP_FIDELITY_EXTRACT_MODEL || fidelityModel(), extracted_moves: [...extracted.values()].map((e) => e.moves), rows }, null, 2));
    console.log(`wrote ${out}`);
  }
  process.exitCode = passed === rows.length ? 0 : 1;
}

main().catch((e) => {
  console.error(`calibration failed: ${e.message}`);
  process.exitCode = 1;
});
