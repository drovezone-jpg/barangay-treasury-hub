/**
 * tests/syntax-check.js — node --check every .js file in the project.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.name === 'node_modules' ? [] :
      d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

const files = walk(path.join(__dirname, '..')).filter((f) => f.endsWith('.js'));
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); console.log('OK  ', f); }
  catch (e) { failed++; console.error('FAIL', f, '\n', e.stderr.toString()); }
}
process.exit(failed ? 1 : 0);
