'use strict';
require('../lib/env');
// Usage: node scripts/set-password.js <employeeCode> <newPassword> [--keep]
// Sets a user's password. The user must change it at next sign-in unless you add --keep.
const { Pool } = require('pg');
const { hashPassword, passwordProblem } = require('../lib/auth');

(async () => {
  const [code, password] = process.argv.slice(2);
  const keep = process.argv.includes('--keep');
  if (!code || !password) { console.error('Usage: npm run user:password -- <employeeCode> <newPassword> [--keep]'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set. Copy .env.example to .env and edit it.'); process.exit(1); }
  const problem = passwordProblem(password, '');
  if (problem) { console.error(problem); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const r = await pool.query(`UPDATE users SET password_hash = $2, must_change = $3 WHERE code = $1 RETURNING name`, [code, await hashPassword(password), !keep]);
    if (!r.rows[0]) { console.error('No employee has the code ' + code + '.'); process.exitCode = 1; }
    else { await pool.query(`DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE code = $1)`, [code]); console.log('Password set for ' + r.rows[0].name + (keep ? '.' : '. They must change it at next sign-in.')); }
  } catch (e) { console.error('Failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();
