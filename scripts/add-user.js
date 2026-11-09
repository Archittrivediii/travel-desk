'use strict';
require('../lib/env');
// Adds an employee who can sign in (for example an approver).
// Usage: npm run user:add -- <code> "<Full name>" <email> <role> <department> [grade] [designation]
//   role: employee | manager (HOD) | admin (finance)
// The temporary password is the same as for the example users; they must change it at first sign-in.
const { Pool } = require('pg');
const { hashPassword, DEFAULT_PASSWORD } = require('../lib/auth');

(async () => {
  const [code, name, email, role, dept, grade = 'L4', desig = ''] = process.argv.slice(2);
  if (!code || !name || !email || !role || !dept) {
    console.error('Usage: npm run user:add -- <code> "<Full name>" <email> <employee|manager|admin> <department> [grade] [designation]');
    process.exit(1);
  }
  if (!['employee', 'manager', 'admin'].includes(role)) { console.error('Role must be employee, manager or admin.'); process.exit(1); }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('That e-mail id does not look right.'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set. Check the .env file.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const dup = await pool.query(`SELECT name FROM users WHERE code = $1 OR lower(email) = lower($2)`, [code, email]);
    if (dup.rows[0]) { console.error('That code or e-mail id already belongs to ' + dup.rows[0].name + '.'); process.exitCode = 1; return; }
    const n = await pool.query(`SELECT COALESCE(max(substring(id from 2)::int), 0) + 1 AS n FROM users WHERE id ~ '^u[0-9]+$'`);
    const id = 'u' + n.rows[0].n;
    await pool.query(
      `INSERT INTO users (id, code, name, role, grade, dept, desig, email, password_hash, must_change) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
      [id, code, name, role, grade, dept, desig, email, await hashPassword(DEFAULT_PASSWORD)]);
    console.log(`Added ${name} (${email}) with employee code ${code}. Temporary password: ${DEFAULT_PASSWORD}`);
  } catch (e) { console.error('Failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();
