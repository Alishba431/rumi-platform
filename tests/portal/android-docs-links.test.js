/**
 * Every relative link in the Android app guides resolves in this repo.
 *
 * The messenger guide's first prerequisite is "connect this repo's bot to a
 * Matrix server". A link to a page that is not in the repo leaves an adopter
 * with no way to do that step, so a dead relative link here fails CI. External
 * links (http/https/mailto) and in-page anchors are not checked.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

const GUIDES = [
  'docs/android-app.md',
  'docs/features/android-portal-app.md',
  'portal/ANDROID.md',
];

// README and SETUP are long and older than this release: check only the lines
// that point at the Android guides.
const SECTIONS = [
  { file: 'README.md', match: /android/i },
  { file: 'SETUP.md', match: /android|matrix/i },
];

function relativeLinks(file, lineFilter = () => true) {
  const out = [];
  fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, idx) => {
    if (!lineFilter(line)) return;
    const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      out.push({ target: target.split('#')[0], line: idx + 1 });
    }
  });
  return out;
}

const cases = [
  ...GUIDES.flatMap((file) => relativeLinks(file).map((l) => [file, l.line, l.target])),
  ...SECTIONS.flatMap(({ file, match }) =>
    relativeLinks(file, (line) => match.test(line)).map((l) => [file, l.line, l.target])),
];

describe('Android guides: relative links resolve', () => {
  it('finds links to check', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases)('%s:%i → %s', (file, _line, target) => {
    const resolved = path.resolve(path.dirname(path.join(ROOT, file)), decodeURIComponent(target));
    expect(fs.existsSync(resolved) ? target : `MISSING ${target}`).toBe(target);
  });
});
