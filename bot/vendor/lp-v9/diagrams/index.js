// ─────────────────────────────────────────────────────────────────────────────
// DIAGRAM ENGINE — deterministic diagram-as-code → SVG for 6-12 lesson plans.
//
// CONTRACT (the only thing a page renderer depends on):
//
//     module.exports.renderDiagram(spec) -> string   // an <svg>…</svg> fragment
//
//   • `spec` is the lp_doc `diagram.spec` object, verbatim. It always has a
//     `type` (string); everything else is the type's own vocabulary. The page
//     renderer never inspects or rewrites it.
//   • The return value is inlined into the page inside a <figure>. It IS an
//     SVG fragment — no <html>, no <script>, no external url() references.
//   • The root <svg> carries a `viewBox` and `width="100%"` plus an inline
//     `height:auto;max-width:100%` — it can never overflow the A4 column.
//   • Colours are emitted as `var(--navy, #0B2545)` etc., so a diagram inherits
//     the LP palette when it is on the page and still renders standalone.
//   • Text is real <text>. Urdu comes through as <foreignObject> + dir="rtl" +
//     the Nastaliq stack, never SVG <text> (SVG has no bidi/shaping guarantees).
//   • Minimum type size is 12 user units ≈ 13 px at a 794 px page width.
//   • THROWS for an unknown `type` — the caller catches, substitutes a placeholder and
//     reports an unrendered diagram rather than shipping a silently blank box.
//   • Pure and SYNCHRONOUS: no network, no async. (It is also await-safe, so
//     `await renderDiagram(spec)` works if a caller prefers that form.)
//
// The one exception to "no filesystem": `labelled_figure` reads an image from a
// path when the spec gives one instead of a data URI. It defaults to pure
// in-process rendering, and labelled_figure is not a lesson-quiz type. Nothing
// here starts a process.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const { texToUnicode } = require("./lib/tex");

const TYPES_DIR = path.join(__dirname, "types");

// ─── VENDOR DIVERGENCE — local divergence from the upstream engine ─
// The contract above says the page renderer never rewrites the spec. This is the
// engine rewriting its OWN input, once, at the door: authored `diagram.spec` strings carry TeX, and
// every type draws them through wrap() + Svg.text(), whose esc() escapes only
// & < > " ' — a `$` and a backslash land in the emitted SVG verbatim. Converting
// at the egress is too late: wrap() measures and breaks the string first, so a
// `$…$` span is already in two pieces by the time anything draws it (which is
// exactly how it was reported — LaTeX split over two lines). The spec is the
// only place a whole span is still whole, so converting here fixes every type
// and both strips at once, and shrinks the string, which makes the pre-computed
// widths over-reserve rather than under-reserve.
/** Deep, non-mutating: every string in the spec, TeX → readable Unicode. */
function deTex(v) {
  if (typeof v === "string") return texToUnicode(v);
  if (Array.isArray(v)) return v.map(deTex);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deTex(v[k]);
    return out;
  }
  return v;
}

function loadRegistry() {
  const reg = new Map();
  const mods = [];
  for (const f of fs.readdirSync(TYPES_DIR).sort()) {
    if (!f.endsWith(".js")) continue;
    // eslint-disable-next-line global-require
    const m = require(path.join(TYPES_DIR, f));
    for (const nm of [m.type, ...(m.aliases || [])]) {
      if (reg.has(nm)) throw new Error(`duplicate diagram type "${nm}" (${f})`);
      reg.set(nm, m);
    }
    mods.push(m);
  }
  return { reg, mods };
}

const { reg: REGISTRY, mods: MODULES } = loadRegistry();

class DiagramError extends Error {}

/**
 * Render one diagram spec to a complete, self-contained SVG string.
 * @param {object} spec {type, ...}
 * @returns {string}
 */
function renderDiagram(spec) {
  if (!spec || typeof spec !== "object") throw new DiagramError("renderDiagram: spec must be an object");
  const t = spec.type;
  if (!t) throw new DiagramError("renderDiagram: spec.type is required");
  const mod = REGISTRY.get(t);
  if (!mod) {
    throw new DiagramError(
      `renderDiagram: unknown diagram type "${t}". Known: ${[...REGISTRY.keys()].sort().join(", ")}`
    );
  }
  const out = mod.render(deTex(spec));
  if (typeof out !== "string" || !out.startsWith("<svg")) {
    throw new DiagramError(`renderDiagram: type "${t}" did not return an <svg> string`);
  }
  return out;
}

/** Every registered type with its aliases, one-line summary and first example. */
function listTypes() {
  return MODULES.map((m) => ({
    type: m.type,
    aliases: m.aliases || [],
    summary: m.summary || "",
    example: (m.examples && m.examples[0] && m.examples[0].spec) || null,
  })).sort((a, b) => a.type.localeCompare(b.type));
}

/** All named examples across all types — used by test.js and the gallery build. */
function allExamples() {
  const out = [];
  for (const m of MODULES) for (const ex of m.examples || []) out.push({ ...ex, type: m.type });
  return out;
}

// The collision contract. `checkOverlaps(svg)` returns [] for a clean diagram
// and one row per colliding pair otherwise. It reads the emitted STRING, so it
// is the same check whether the SVG came from this engine, a cached document,
// or a caller's own gate (the lesson quiz's figure gates).
const { checkOverlaps, elementBoxes, textBox } = require("./lib/measure");

// The DEGENERACY contract, alongside the collision one. checkOverlaps asks "can you read every
// label?"; checkDegenerate asks "is there a shape here worth reading?" — a near-flat
// parallelogram passes the first and fails the second. See lib/degenerate.js.
const { checkDegenerate } = require("./lib/degenerate");

module.exports = {
  renderDiagram,
  listTypes,
  allExamples,
  checkOverlaps,
  checkDegenerate,
  elementBoxes,
  textBox,
  DiagramError,
  IS_STUB: false,
};
