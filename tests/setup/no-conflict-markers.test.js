/**
 * No merge-conflict markers in tracked text files.
 *
 * A conflict resolved by hand (or by a script) can leave one marker line behind. In a
 * SQL file that line is a syntax error that only a fresh install hits: the upgrade path
 * runs the versioned migrations and never reads 00_complete-schema.sql, so every other
 * check stays green while a new deployment cannot create its schema. This scans every
 * tracked text file for a line that is exactly a marker (`<<<<<<< `, `=======`,
 * `>>>>>>> `, `||||||| `), which is what git writes.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

const TEXT_EXT = /\.(?:sql|js|cjs|mjs|ts|tsx|jsx|json|md|ya?ml|py|sh|html|ejs|css|txt|toml|gradle|kts|xml|properties)$/;
const TEXT_NAMES = new Set(['.env.template', 'Procfile', 'Dockerfile', '.gitignore']);
const MARKER_RE = /^(?:<{7} |={7}$|>{7} |\|{7} )/;

function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter((f) => f && (TEXT_EXT.test(f) || TEXT_NAMES.has(path.basename(f))));
}

describe('no merge-conflict markers', () => {
  it('no tracked text file contains a conflict-marker line', () => {
    const hits = [];
    for (const rel of trackedTextFiles()) {
      let text;
      try {
        text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') continue; // removed in the working tree
        throw error;
      }
      text.split('\n').forEach((line, i) => {
        if (MARKER_RE.test(line)) hits.push(`${rel}:${i + 1}: ${line}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
