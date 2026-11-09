'use strict';
require('../lib/env');
// Sets the details shown on the appraisal form.
// Usage: npm run user:profile -- <employee code> [--manager <manager's employee code>] [--role "Current role"] [--doj YYYY-MM-DD]
const { Pool } = require('pg');

(async () => {
  const args = process.argv.slice(2);
  const code = args[0];
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const manager = opt('--manager'), role = opt('--role'), doj = opt('--doj');
  if (!code || code.startsWith('--') || (manager === undefined && role === undefined && doj === undefined)) {
    console.error('Usage: npm run user:profile -- <employee code> [--manager <manager code>] [--role "Current role"] [--doj YYYY-MM-DD]');
    process.exit(1);
  }
  if (doj !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(doj)) { console.error('Write the date of joining as YYYY-MM-DD, for example 2019-04-01.'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set. Check the .env file.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const u = await pool.query(`SELECT id, name FROM users WHERE code = $1`, [code]);
    if (!u.rows[0]) { console.error('No employee has the code ' + code + '.'); process.exitCode = 1; return; }
    if (manager !== undefined) {
      const m = await pool.query(`SELECT id, name FROM users WHERE code = $1`, [manager]);
      if (!m.rows[0]) { console.error('No employee has the manager code ' + manager + '.'); process.exitCode = 1; return; }
      if (m.rows[0].id === u.rows[0].id) { console.error('A person cannot report to themselves.'); process.exitCode = 1; return; }
      await pool.query(`UPDATE users SET reporting_to = $2 WHERE id = $1`, [u.rows[0].id, m.rows[0].id]);
      console.log(u.rows[0].name + ' now reports to ' + m.rows[0].name + '.');
    }
    if (role !== undefined) { await pool.query(`UPDATE users SET cur_role = $2 WHERE id = $1`, [u.rows[0].id, role]); console.log('Current role set to "' + role + '".'); }
    if (doj !== undefined) { await pool.query(`UPDATE users SET doj = $2::date WHERE id = $1`, [u.rows[0].id, doj]); console.log('Date of joining set to ' + doj + '.'); }
  } catch (e) { console.error('Failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();
