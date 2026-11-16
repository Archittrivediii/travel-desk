'use strict';
// Creates the tables. With --seed it also loads the example data (this replaces existing rows).
require('../lib/env');
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { setDefaultPasswords, DEFAULT_PASSWORD } = require('../lib/auth');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and edit it.');
    process.exit(1);
  }
  const pool = db.createPool();
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    console.log('Tables are ready.');
    if (process.argv.includes('--seed')) {
      await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8'));
      console.log('Example data loaded.');
      const n = await setDefaultPasswords((t, p) => pool.query(t, p));
      console.log(n + ' users can sign in with the password ' + DEFAULT_PASSWORD + ' and must change it at first sign-in.');
    }
  } catch (e) {
    console.error('Database setup failed: ' + db.explain(e));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
