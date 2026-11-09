'use strict';
// Loads KEY=VALUE lines from a .env file in the project folder. Variables already set in the environment win.
const fs = require('fs');
const path = require('path');
try {
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
} catch (e) { /* no .env file: use real environment variables */ }
