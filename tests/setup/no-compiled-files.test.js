/**
 * No compiled Python in the repo.
 *
 * A .pyc file records the absolute path of the source it was compiled from, so a committed one
 * publishes the build machine's directory layout, and it goes stale the moment the .py changes.
 * .gitignore already lists __pycache__/ and *.pyc; this catches a file added with `git add -f`
 * or committed before the ignore rule existed.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

describe('no compiled files', () => {
  it('tracks no .pyc file and no __pycache__ directory', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.py[co]$/.test(f) || f.split('/').includes('__pycache__'));
    expect(tracked).toEqual([]);
  });
});
