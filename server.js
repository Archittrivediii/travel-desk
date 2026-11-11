'use strict';
require('./lib/env');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const mail = require('./lib/mail');
const { hashPassword, verifyPassword, passwordProblem, setDefaultPasswords } = require('./lib/auth');

types.setTypeParser(1082, (v) => v);              // date -> 'YYYY-MM-DD' string
types.setTypeParser(1700, (v) => parseFloat(v));  // numeric -> number

const PORT = Number(process.env.PORT) || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

// ---------- reads ----------
async function getState(actor) {
  const [users, policy, budgets, trips, expenses, claims, files, appr] = await Promise.all([
    q(`SELECT id, code, name, role, grade, dept, desig, COALESCE(email,'') AS email,
              COALESCE(l4_email,'') AS l4, COALESCE(l5_email,'') AS l5, COALESCE(l6_email,'') AS l6 FROM users ORDER BY id`),
    q(`SELECT grade, cls, hotel, da FROM policy ORDER BY grade`),
    q(`SELECT dept, amount FROM budgets ORDER BY dept`),
    q(`SELECT id, emp, from_city AS "from", to_city AS "to", dep, ret, purpose, cls, fare, hotel, advance, status
         FROM trips ORDER BY created_at, id`),
    q(`SELECT id, emp, COALESCE(trip_id, '') AS trip, COALESCE(claim_id, '') AS "claimId", section AS cat, mode, d_from AS "dFrom", d_to AS "dTo",
              d_from AS date, from_loc AS "from", to_loc AS "to", city, qty, rate, amt, cur, note, region, status
         FROM expenses ORDER BY created_at, id`),
    q(`SELECT c.id, c.emp, c.purpose, c.planned, c.action, c.pending, c.status, c.submitted_at AS "submittedAt"
         FROM claims c JOIN users u ON u.id = c.emp
        WHERE ($2::text = 'admin' OR c.emp = $1::text OR ($2::text = 'manager' AND u.dept = $3::text)
               OR EXISTS (SELECT 1 FROM claim_approvers x WHERE x.claim_id = c.id AND lower(x.email) = lower($4::text)))
        ORDER BY c.created_at, c.id`, [actor.id, actor.role, actor.dept, actor.email || '']),
    q(`SELECT f.id, f.claim_id AS "claimId", f.name, f.size
         FROM claim_files f JOIN claims c ON c.id = f.claim_id JOIN users u ON u.id = c.emp
        WHERE ($2::text = 'admin' OR c.emp = $1::text OR ($2::text = 'manager' AND u.dept = $3::text)
               OR EXISTS (SELECT 1 FROM claim_approvers x WHERE x.claim_id = c.id AND lower(x.email) = lower($4::text)))
        ORDER BY f.id`, [actor.id, actor.role, actor.dept, actor.email || '']),
    q(`SELECT a.claim_id AS "claimId", a.level, a.email, a.status, a.acted_at AS "date", a.remarks
         FROM claim_approvers a JOIN claims c ON c.id = a.claim_id JOIN users u ON u.id = c.emp
        WHERE ($2::text = 'admin' OR c.emp = $1::text OR ($2::text = 'manager' AND u.dept = $3::text)
               OR EXISTS (SELECT 1 FROM claim_approvers x WHERE x.claim_id = c.id AND lower(x.email) = lower($4::text)))
        ORDER BY a.claim_id, a.level`, [actor.id, actor.role, actor.dept, actor.email || '']),
  ]);
  const pol = {};
  policy.rows.forEach((r) => { pol[r.grade] = { cls: r.cls, hotel: r.hotel, da: r.da }; });
  const bud = {};
  budgets.rows.forEach((r) => { bud[r.dept] = r.amount; });
  const cl = claims.rows.map((c) => Object.assign({ l1: '', l2: '', l3: '', l4: '', l5: '', l6: '' }, c, appr.rows.filter((a) => a.claimId === c.id).reduce((o, a) => { o['l' + a.level] = a.email; return o; }, {}), { approvals: appr.rows.filter((a) => a.claimId === c.id).map((a) => ({ level: a.level, email: a.email, status: a.status, date: a.date, remarks: a.remarks })), files: files.rows.filter((f) => f.claimId === c.id).map((f) => ({ id: String(f.id), name: f.name, size: f.size })) }));
  return { users: users.rows, policy: pol, budgets: bud, trips: trips.rows, expenses: expenses.rows, claims: cl };
}

// ---------- e-mail notifications ----------
const appUrl = () => (process.env.APP_URL || 'http://localhost:' + PORT).replace(/\/+$/, '');
async function queueMail(claimId, to, subject, body) {
  if (!to) return;
  const r = await q(`INSERT INTO mail_outbox (claim_id, to_email, subject, body, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [claimId, to, subject, body, mail.configured() ? 'Queued' : 'Not configured']);
  if (!mail.configured()) { console.error('E-mail not sent to ' + to + ': e-mail is OFF (check SMTP_HOST and MAIL_FROM in .env, then restart).'); return; }
  const id = r.rows[0].id;
  mail.send({ to, subject, text: body })
    .then(() => q(`UPDATE mail_outbox SET status = 'Sent', sent_at = now() WHERE id = $1::bigint`, [id]))
    .catch((e) => { console.error('E-MAIL FAILED to ' + to + ': ' + e.message); return q(`UPDATE mail_outbox SET status = 'Failed', error = $2 WHERE id = $1::bigint`, [id, String(e.message).slice(0, 500)]); })
    .catch(() => {});
}

// event: 'submitted' | 'approved' | 'rejected'. Tells the requester, and the next approver when there is one.
async function notifyClaim(claimId, event, by, remarks) {
  try {
    const c = (await q(`SELECT c.id, c.purpose, u.name, COALESCE(u.email, '') AS email FROM claims c JOIN users u ON u.id = c.emp WHERE c.id = $1`, [claimId])).rows[0];
    if (!c) return;
    const tot = (await q(`SELECT cur, sum(amt)::text AS amt FROM expenses WHERE claim_id = $1 GROUP BY cur ORDER BY cur`, [claimId])).rows
      .map((r) => r.cur + ' ' + Number(r.amt).toLocaleString('en-IN')).join(' + ') || '-';
    const lv = (await q(`SELECT level, email, status FROM claim_approvers WHERE claim_id = $1 ORDER BY level`, [claimId])).rows;
    const next = lv.find((r) => r.status === 'Pending');
    const first = (n) => String(n || '').split(' ')[0] || 'there';
    const who = async (e) => (await q(`SELECT name FROM users WHERE lower(email) = lower($1) LIMIT 1`, [e])).rows[0];
    const nextUser = next ? await who(next.email) : null;
    const info = `Travel request: ${c.id}\nEmployee: ${c.name}\nPurpose: ${c.purpose}\nTotal: ${tot}`;
    const open = `\nOpen Travel Desk: ${appUrl()}\n\nThis is an automatic message from Travel Desk.`;
    if (event === 'submitted') {
      await queueMail(claimId, c.email, `Travel request ${c.id} submitted`,
        `Hello ${first(c.name)},\n\nYour travel request has been submitted for approval.\n\n${info}\n\nIt is now with ${next ? next.email + ' (L' + next.level + ' Manager)' : 'the approvers'}.\n${open}`);
    } else if (event === 'approved' && next) {
      await queueMail(claimId, c.email, `Travel request ${c.id} approved by ${by}`,
        `Hello ${first(c.name)},\n\nYour travel request was approved by ${by}${remarks ? ' (remarks: ' + remarks + ')' : ''}.\n\n${info}\n\nIt is now with ${next.email} (L${next.level} Manager).\n${open}`);
    } else if (event === 'approved') {
      await queueMail(claimId, c.email, `Travel request ${c.id} fully approved`,
        `Hello ${first(c.name)},\n\nYour travel request was approved by ${by}${remarks ? ' (remarks: ' + remarks + ')' : ''}. All approvals are complete and finance can now reimburse it.\n\n${info}\n${open}`);
    } else if (event === 'rejected') {
      await queueMail(claimId, c.email, `Travel request ${c.id} rejected`,
        `Hello ${first(c.name)},\n\nYour travel request was rejected by ${by}.\nRemarks: ${remarks || '-'}\n\n${info}\n${open}`);
    }
    if (next && event !== 'rejected') {
      await queueMail(claimId, next.email, `Action needed: travel request ${c.id} from ${c.name}`,
        `Hello ${first(nextUser && nextUser.name)},\n\nA travel request is waiting for your approval (you are the L${next.level} Manager).\n\n${info}\n\nOpen the Approval Center, tick the request and press Approve or Reject.\n${open}`);
    }
  } catch (e) { console.error('Notification failed: ' + e.message); }
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', async () => { await q('SELECT 1'); return { ok: true }; });
route('GET', '/api/state', async ({ actor }) => getState(actor));

route('POST', '/api/trips', async ({ actor, body }) => {
  const t = {
    from: text(body.from, 10), to: text(body.to, 10), purpose: text(body.purpose, 120),
    dep: body.dep, ret: body.ret, cls: num(body.cls), fare: num(body.fare), hotel: num(body.hotel), advance: body.advance === undefined || body.advance === '' ? 0 : num(body.advance),
  };
  if (!t.from || !t.to || t.from === t.to) throw bad('Choose two different cities.');
  if (!t.purpose) throw bad('Add a purpose for the trip.');
  if (!isDate(t.dep) || !isDate(t.ret) || t.ret < t.dep) throw bad('Return date must be on or after the departure date.');
  if (![0, 1, 2].includes(t.cls)) throw bad('Choose a travel class.');
  if (!(t.fare > 0)) throw bad('Enter the round-trip fare.');
  if (!(t.hotel >= 0)) throw bad('Enter the hotel rate per night.');
  if (!(t.advance >= 0)) throw bad('Enter the advance taken as 0 or more.');
  const status = actor.role === 'employee' ? 'Pending manager' : 'Pending finance';
  const r = await q(
    `INSERT INTO trips (emp, from_city, to_city, dep, ret, purpose, cls, fare, hotel, advance, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, status`,
    [actor.id, t.from, t.to, t.dep, t.ret, t.purpose, t.cls, t.fare, t.hotel, t.advance, status]);
  return r.rows[0];
});

route('POST', '/api/trips/:id/decision', async ({ actor, params, body }) => {
  const r = await q(
    `SELECT t.id, t.emp, t.status, t.cls, t.hotel, p.cls AS max_cls, p.hotel AS max_hotel
       FROM trips t JOIN users u ON u.id = t.emp JOIN policy p ON p.grade = u.grade WHERE t.id = $1`, [params.id]);
  const t = r.rows[0];
  if (!t) throw new HttpError(404, 'Trip not found.');
  const allowed = t.emp !== actor.id && (
    (t.status === 'Pending manager' && actor.role === 'manager') ||
    (t.status === 'Pending finance' && actor.role === 'admin'));
  if (!allowed) throw new HttpError(403, 'You cannot decide this request.');
  const outOfPolicy = t.cls > t.max_cls || t.hotel > t.max_hotel;
  const next = body.approve === true
    ? (t.status === 'Pending manager' && outOfPolicy ? 'Pending finance' : 'Approved')
    : 'Rejected';
  const u = await q(`UPDATE trips SET status = $2 WHERE id = $1 AND status = $3 RETURNING id, status`, [t.id, next, t.status]);
  if (!u.rows[0]) throw new HttpError(409, 'This request was already decided.');
  return u.rows[0];
});

route('POST', '/api/expenses', async ({ actor, body }) => {
  const e = {
    trip: text(body.trip, 20), section: text(body.section, 20), mode: text(body.mode, 60),
    dFrom: body.dFrom, dTo: body.dTo, from: text(body.from, 60), to: text(body.to, 60), city: text(body.city, 40),
    qty: num(body.qty), rate: num(body.rate), amt: num(body.amt), cur: text(body.cur, 3).toUpperCase() || 'INR',
    note: text(body.note, 100), region: body.region === 'intl' ? 'intl' : 'dom',
  };
  if (!e.section || !e.mode) throw bad('Choose a section and mode.');
  if (!isDate(e.dFrom) || !isDate(e.dTo) || e.dTo < e.dFrom) throw bad('Date/To cannot be before Date/From.');
  if (!(e.amt > 0)) throw bad('Enter an amount greater than zero.');
  if (!/^[A-Z]{3}$/.test(e.cur)) throw bad('Choose a currency.');
  if (e.section === 'Misc.' && !e.note) throw bad('Add a remark for miscellaneous expenses.');
  if (e.trip) {
    const t = await q(`SELECT 1 FROM trips WHERE id = $1 AND emp = $2 AND status = 'Approved'`, [e.trip, actor.id]);
    if (!t.rows[0]) throw bad('Linked trip must be one of your approved trips.');
  }
  const r = await q(
    `INSERT INTO expenses (emp, trip_id, section, mode, d_from, d_to, from_loc, to_loc, city, qty, rate, amt, cur, note, region, status)
     VALUES ($1, NULLIF($2,''), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Draft') RETURNING id`,
    [actor.id, e.trip, e.section, e.mode, e.dFrom, e.dTo, e.from, e.to, e.city,
     Number.isNaN(e.qty) ? null : e.qty, Number.isNaN(e.rate) ? null : e.rate, e.amt, e.cur, e.note, e.region]);
  return r.rows[0];
});

route('DELETE', '/api/drafts', async ({ actor }) => {
  const r = await q(`DELETE FROM expenses WHERE emp = $1 AND status = 'Draft' RETURNING id`, [actor.id]);
  await q(`DELETE FROM claims WHERE emp = $1 AND status = 'Draft'`, [actor.id]);
  return { removed: r.rows.length };
});

route('DELETE', '/api/expenses/:id', async ({ actor, params }) => {
  const r = await q(`DELETE FROM expenses WHERE id = $1 AND emp = $2 AND status = 'Draft' RETURNING id`, [params.id, actor.id]);
  if (!r.rows[0]) throw new HttpError(404, 'Only your own unsent rows can be removed.');
  return { id: r.rows[0].id };
});

// Step 1: the Task/Action screen creates (or updates) the draft travel request, which gives the request number.
route('POST', '/api/claims/draft', async ({ actor, body }) => {
  const t = (v) => String(v == null ? '' : v).trim().slice(0, 4000);
  const purpose = t(body.purpose);
  if (!purpose) throw bad('Enter the purpose of travel.');
  const n = await q(`SELECT count(*)::int AS n FROM expenses WHERE emp = $1 AND status = 'Draft'`, [actor.id]);
  if (!n.rows[0].n) throw bad('There are no unsent rows to submit.');
  const cur = await q(`SELECT id FROM claims WHERE emp = $1 AND status = 'Draft' ORDER BY created_at DESC LIMIT 1`, [actor.id]);
  let id;
  if (cur.rows[0]) {
    id = cur.rows[0].id;
    await q(`UPDATE claims SET purpose = $2, planned = $3, action = $4, pending = $5 WHERE id = $1`, [id, purpose, t(body.planned), t(body.action), t(body.pending)]);
  } else {
    const r = await q(`INSERT INTO claims (emp, purpose, planned, action, pending) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [actor.id, purpose, t(body.planned), t(body.action), t(body.pending)]);
    id = r.rows[0].id;
  }
  await q(`UPDATE expenses SET claim_id = $2 WHERE emp = $1 AND status = 'Draft'`, [actor.id, id]);
  return { id };
});

const FILE_TYPES = {
  pdf: { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
};
const MAX_FILE = 5 * 1024 * 1024, MAX_FILES = 10;

async function ownDraftClaim(actor, id) {
  const c = await q(`SELECT id FROM claims WHERE id = $1 AND emp = $2 AND status = 'Draft'`, [id, actor.id]);
  if (!c.rows[0]) throw new HttpError(404, 'This travel request is not open for changes.');
}

route('POST', '/api/claims/:id/files', async ({ actor, params, body }) => {
  await ownDraftClaim(actor, params.id);
  const name = text(body.name, 200).replace(/[\\/\r\n"]/g, '_');
  const ext = (name.split('.').pop() || '').toLowerCase();
  const ft = FILE_TYPES[ext];
  if (!name || !ft) throw bad('Attach a PDF, PNG or JPG file.');
  const buf = Buffer.from(String(body.data || ''), 'base64');
  if (!buf.length) throw bad('The file is empty.');
  if (buf.length > MAX_FILE) throw bad('Each file must be 5 MB or smaller.');
  if (!ft.magic.every((b, i) => buf[i] === b)) throw bad('The file content does not match its type.');
  const n = await q(`SELECT count(*)::int AS n FROM claim_files WHERE claim_id = $1`, [params.id]);
  if (n.rows[0].n >= MAX_FILES) throw bad('You can attach up to ' + MAX_FILES + ' files.');
  const r = await q(`INSERT INTO claim_files (claim_id, name, mime, size, data) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [params.id, name, ft.mime, buf.length, buf.toString('base64')]);
  return { id: String(r.rows[0].id) };
});

route('DELETE', '/api/files/:id', async ({ actor, params }) => {
  const r = await q(`DELETE FROM claim_files f USING claims c WHERE f.id = $1::bigint AND f.claim_id = c.id AND c.emp = $2 AND c.status = 'Draft' RETURNING f.id`, [params.id, actor.id]);
  if (!r.rows[0]) throw new HttpError(404, 'File not found.');
  return { ok: true };
});

route('GET', '/api/files/:id', async ({ actor, params }) => {
  if (!/^\d{1,18}$/.test(params.id)) throw new HttpError(404, 'File not found.');
  const r = await q(`SELECT f.name, f.mime, f.data FROM claim_files f JOIN claims c ON c.id = f.claim_id JOIN users u ON u.id = c.emp
      WHERE f.id = $1::bigint AND ($4::text = 'admin' OR c.emp = $2::text OR ($4::text = 'manager' AND u.dept = $3::text)
        OR EXISTS (SELECT 1 FROM claim_approvers x WHERE x.claim_id = c.id AND lower(x.email) = lower($5::text)))`,
    [params.id, actor.id, actor.dept, actor.role, actor.email || '']);
  if (!r.rows[0]) throw new HttpError(404, 'File not found.');
  return { raw: Buffer.from(r.rows[0].data, 'base64'), mime: r.rows[0].mime, name: r.rows[0].name };
});

// Step 2: the final screen picks the L1-L3 manager e-mail ids and sends the request.
route('POST', '/api/claims/submit', async ({ actor, body }) => {
  const claimId = text(body.claim, 30);
  await ownDraftClaim(actor, claimId);
  const files = await q(`SELECT count(*)::int AS n FROM claim_files WHERE claim_id = $1`, [claimId]);
  if (!files.rows[0].n) throw bad('Attach at least one invoice.');
  const allowed = await q(`SELECT lower(email) AS email FROM users WHERE role IN ('manager','admin') AND id <> $1 AND email IS NOT NULL`, [actor.id]);
  const ok = new Set(allowed.rows.map((r) => r.email));
  const pick = [text(body.l1, 120).toLowerCase(), text(body.l2, 120).toLowerCase(), text(body.l3, 120).toLowerCase()];
  if (!pick[0]) throw bad('Select the L1 Manager e-mail id.');
  pick.forEach((e) => { if (e && !ok.has(e)) throw bad('Choose the manager e-mail ids from the list.'); });
  const given = pick.filter(Boolean);
  if (new Set(given).size !== given.length) throw bad('Each manager e-mail id can be used once.');
  const me = await q(`SELECT COALESCE(l4_email,'') AS l4, COALESCE(l5_email,'') AS l5, COALESCE(l6_email,'') AS l6 FROM users WHERE id = $1`, [actor.id]);
  const m = me.rows[0];
  await q(`UPDATE claims SET status = 'Submitted', submitted_at = now() WHERE id = $1`, [claimId]);
  await q(`DELETE FROM claim_approvers WHERE claim_id = $1`, [claimId]);
  const lv = [pick[0], pick[1], pick[2], m.l4, m.l5, m.l6];
  for (let i = 0; i < lv.length; i++) {
    if (lv[i]) await q(`INSERT INTO claim_approvers (claim_id, level, email) VALUES ($1, $2, $3)`, [claimId, i + 1, lv[i]]);
  }
  const r = await q(`UPDATE expenses SET status = 'Pending HOD', updated_at = now() WHERE emp = $1 AND status = 'Draft' AND claim_id = $2 RETURNING id`, [actor.id, claimId]);
  if (!r.rows.length) throw bad('There are no unsent rows to submit.');
  await notifyClaim(claimId, 'submitted');
  return { id: claimId, submitted: r.rows.length };
});

// An HOD decides claims from their own department. Finance decides claims filed by HODs. Nobody decides their own.
const DECIDE_WHERE = `e.status = 'Pending HOD' AND e.claim_id IS NULL AND e.emp <> $3::text AND (
    ($4::text = 'manager' AND u.dept = $5::text AND u.role <> 'manager') OR ($4::text = 'admin' AND u.role = 'manager'))`;

route('POST', '/api/expenses/:id/decision', async ({ actor, params, body }) => {
  if (body.action === 'pay') {
    const r = await q(`UPDATE expenses SET status = 'Reimbursed', updated_at = now()
                        WHERE id = $1 AND status = 'Approved' AND $2::text = 'admin' RETURNING id, status`, [params.id, actor.role]);
    if (!r.rows[0]) throw new HttpError(403, 'Only finance can reimburse approved expenses.');
    return r.rows[0];
  }
  if (body.action !== 'approve' && body.action !== 'reject') throw bad('Unknown action.');
  const next = body.action === 'approve' ? 'Approved' : 'Rejected';
  const r = await q(
    `UPDATE expenses e SET status = $2::text, updated_at = now() FROM users u
      WHERE e.id = $1 AND u.id = e.emp AND ${DECIDE_WHERE} RETURNING e.id, e.status`,
    [params.id, next, actor.id, actor.role, actor.dept]);
  if (!r.rows[0]) throw new HttpError(403, 'You cannot decide this expense.');
  return r.rows[0];
});

route('POST', '/api/claims/decision', async ({ actor, body }) => {
  const emp = text(body.emp, 20);
  const next = body.approve === true ? 'Approved' : 'Rejected';
  const r = await q(
    `UPDATE expenses e SET status = $2::text, updated_at = now() FROM users u
      WHERE e.emp = $1::text AND u.id = e.emp AND ${DECIDE_WHERE} RETURNING e.id`,
    [emp, next, actor.id, actor.role, actor.dept]);
  if (!r.rows.length) throw new HttpError(403, 'There are no claims you can decide for this employee.');
  return { decided: r.rows.length, status: next };
});

// Expense Approval Center: the next approver in the chain approves or rejects; each level acts in turn.
route('POST', '/api/claims/approvals', async ({ actor, body }) => {
  const list = Array.isArray(body.decisions) ? body.decisions.slice(0, 100) : [];
  if (!list.length) throw bad('Select at least one request.');
  const me = String(actor.email || '').toLowerCase();
  if (!me) throw bad('No e-mail id is set for your account.');
  let done = 0;
  for (const d of list) {
    const id = text(d && d.claim, 30), approve = d && d.action === 'approve', remarks = text(d && d.remarks, 500);
    if (!approve && !(d && d.action === 'reject')) throw bad('Invalid decision.');
    if (!approve && !remarks) throw bad('Enter remarks to reject ' + id + '.');
    const c = await q(`SELECT emp FROM claims WHERE id = $1 AND status = 'Submitted'`, [id]);
    if (!c.rows[0]) throw new HttpError(404, 'Request ' + id + ' was not found.');
    if (c.rows[0].emp === actor.id) throw new HttpError(403, 'You cannot decide your own request.');
    const rows = (await q(`SELECT level, lower(email) AS email, status FROM claim_approvers WHERE claim_id = $1 ORDER BY level`, [id])).rows;
    if (rows.some((r) => r.status === 'Rejected')) throw new HttpError(409, id + ' was already rejected.');
    const next = rows.find((r) => r.status === 'Pending');
    if (!next) throw new HttpError(409, id + ' is already fully approved.');
    if (next.email !== me) throw new HttpError(403, 'It is not your turn to decide ' + id + '.');
    if (approve) {
      for (const r of rows.filter((x) => x.status === 'Pending')) {      // same e-mail id on following levels counts too
        if (r.email !== me) break;
        await q(`UPDATE claim_approvers SET status = 'Approved', acted_at = now(), remarks = $3 WHERE claim_id = $1 AND level = $2`, [id, r.level, remarks]);
      }
      const left = await q(`SELECT count(*)::int AS n FROM claim_approvers WHERE claim_id = $1 AND status = 'Pending'`, [id]);
      if (!left.rows[0].n) await q(`UPDATE expenses SET status = 'Approved', updated_at = now() WHERE claim_id = $1 AND status = 'Pending HOD'`, [id]);
      await notifyClaim(id, 'approved', me, remarks);
    } else {
      await q(`UPDATE claim_approvers SET status = 'Rejected', acted_at = now(), remarks = $3 WHERE claim_id = $1 AND level = $2`, [id, next.level, remarks]);
      await q(`UPDATE expenses SET status = 'Rejected', updated_at = now() WHERE claim_id = $1 AND status = 'Pending HOD'`, [id]);
      await notifyClaim(id, 'rejected', me, remarks);
    }
    done++;
  }
  return { decided: done };
});

// ---------- Performance management (PMS) ----------
const PMS_TYPES = ['Setting New KRA', 'Mid Year Appraisal', 'Annual Appraisal'];
const PMS_TIMELINES = ['Monthly', 'Daily', 'H1', 'H2', 'Yearly', 'Ongoing'];

// You may open your own appraisal, or one of the people who report to you.
async function pmsAccess(actor, empId) {
  const u = (await q(`SELECT id, reporting_to FROM users WHERE id = $1`, [empId])).rows[0];
  if (!u) throw new HttpError(404, 'Employee not found.');
  const self = u.id === actor.id, mgr = u.reporting_to === actor.id;
  if (!self && !mgr) throw new HttpError(403, "You can open only your own appraisal or your team's.");
  return { self, mgr };
}

function pmsKey(body, actor) {
  const emp = text(body.emp, 20) || actor.id;
  const type = text(body.type, 40) || 'Setting New KRA';
  const year = text(body.year, 7);
  if (!PMS_TYPES.includes(type)) throw bad('Choose the appraisal type from the list.');
  const y = Number(year.slice(0, 4));
  if (!/^\d{4}-\d{2}$/.test(year) || (y + 1) % 100 !== Number(year.slice(5))) throw bad('Choose the year of appraisal from the list.');
  return { emp, type, year, y };
}

// The PMS number of an employee for a year (made when the Setting New KRA form is first saved).
async function pmsNumber(emp, year) {
  const r = (await q(`SELECT cycle_no FROM pms_appraisals WHERE emp = $1 AND year = $2 AND cycle_no IS NOT NULL ORDER BY created_at LIMIT 1`, [emp, year])).rows[0];
  return r ? r.cycle_no : null;
}

const KRA_COLS = `k.sno, k.kra, k.source, k.threshold, k.target, k.weight, k.timeline`;

async function pmsPayload(actor, empId, type, year) {
  const acc = await pmsAccess(actor, empId);
  const emp = (await q(`SELECT u.id, u.name, u.desig, u.dept, COALESCE(u.cur_role, '') AS "curRole", COALESCE(to_char(u.doj, 'YYYY-MM-DD'), '') AS doj,
                               COALESCE(m.name, '') AS manager
                          FROM users u LEFT JOIN users m ON m.id = u.reporting_to WHERE u.id = $1`, [empId])).rows[0];
  const team = (await q(`SELECT id, name FROM users WHERE reporting_to = $1 ORDER BY name`, [actor.id])).rows;
  const no = await pmsNumber(empId, year);
  const a = (await q(`SELECT id, status, values_weight FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [empId, type, year])).rows[0];
  let kras = a ? (await q(`SELECT id::text AS id, sno, kra, source, threshold, target, weight, timeline, self_ach AS "selfAch", mgr_ach AS "mgrAch", remarks
                             FROM pms_kras WHERE appraisal_id = $1 ORDER BY sno, id`, [a.id])).rows : [];
  // Mid-year and annual forms start from everything already entered (goals, ratings, remarks), the Annual one from the Mid Year form; they are stored when the form is saved.
  if (!kras.length && type !== 'Setting New KRA' && no) {
    kras = (await q(`SELECT NULL::text AS id, ${KRA_COLS}, k.self_ach AS "selfAch", k.mgr_ach AS "mgrAch", k.remarks FROM pms_kras k
                      WHERE k.appraisal_id = (SELECT p.id FROM pms_appraisals p WHERE p.emp = $1 AND p.year = $2 AND p.type IN ('Setting New KRA', 'Mid Year Appraisal') AND p.type <> $3
                                               ORDER BY CASE p.type WHEN 'Mid Year Appraisal' THEN 1 ELSE 2 END LIMIT 1) ORDER BY k.sno`, [empId, year, type])).rows;
  }
  const blocked = type !== 'Setting New KRA' && !no ? 'Set and save the KRAs for this year first (choose Type: Setting New KRA).' : '';
  const values = await pmsValues(empId, type, year, a);
  return { employee: emp, team, appraisal: { id: a ? a.id : null, no, type, year, status: a ? a.status : 'Draft' }, kras, can: acc, blocked, values };
}


// ----- Page 2: values assessment -----
async function valuesMaster() {
  const w = (await q(`SELECT value FROM pms_settings WHERE key = 'values_weightage'`)).rows[0];
  const rows = (await q(`SELECT ord, lvl, code, label, marks FROM pms_value_master ORDER BY ord, id`)).rows;
  return { weight: w ? Number(w.value) : 20, rows: rows.map((r, i) => ({ ...r, ord: i + 1 })) };
}
const VAL_COLS = `ord, lvl, code, label, marks, self_ach AS "selfAch", mgr_ach AS "mgrAch", remarks`;
// The list of attributes for one appraisal: its own copy if it was saved, else (Annual) the Mid Year copy, else the master list.
async function valuesBase(emp, year, type, a) {
  const own = a ? (await q(`SELECT ${VAL_COLS} FROM pms_value_rows WHERE appraisal_id = $1 ORDER BY ord`, [a.id])).rows : [];
  // A copy with no rating and no remark yet is just a copy of the list: use the current list instead.
  const used = own.some((r) => r.selfAch != null || r.mgrAch != null || (r.remarks || '').trim());
  if (own.length && used) return { weight: a.values_weight == null ? (await valuesMaster()).weight : Number(a.values_weight), rows: own, stored: true };
  if (type === 'Annual Appraisal') {
    const m = (await q(`SELECT id, values_weight FROM pms_appraisals WHERE emp = $1 AND year = $2 AND type = 'Mid Year Appraisal'`, [emp, year])).rows[0];
    const rows = m ? (await q(`SELECT ${VAL_COLS} FROM pms_value_rows WHERE appraisal_id = $1 ORDER BY ord`, [m.id])).rows : [];
    if (rows.length) return { weight: m.values_weight == null ? (await valuesMaster()).weight : Number(m.values_weight), rows, stored: false };
  }
  const mm = await valuesMaster();
  return { weight: mm.weight, rows: mm.rows.map((r) => ({ ...r, selfAch: null, mgrAch: null, remarks: '' })), stored: false };
}
async function pmsValues(emp, type, year, a) {
  const b = await valuesBase(emp, year, type, a);
  return { weight: b.weight, rows: b.rows };
}

// Opens a form. Nothing is created and no number is used by just looking.
route('POST', '/api/pms/open', async ({ actor, body }) => {
  const k = pmsKey(body, actor);
  return pmsPayload(actor, k.emp, k.type, k.year);
});

// Saves the KRA table. The appraisee can change the self rating (H), the manager the manager rating (I);
// both can edit the goals and the remarks. Each side's own column is kept when the other saves.
// The first save of Setting New KRA for an employee and year creates the PMS number.
route('POST', '/api/pms/save', async ({ actor, body }) => {
  const k = pmsKey(body, actor);
  const acc = await pmsAccess(actor, k.emp);
  const rate = k.type !== 'Setting New KRA';          // ratings are only entered in the mid-year and annual appraisals
  let a = (await q(`SELECT id, status FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  if (a && a.status !== 'Draft') throw new HttpError(409, 'This appraisal is locked.');
  const list = Array.isArray(body.kras) ? body.kras.slice(0, 50) : [];
  const old = {};
  if (a) (await q(`SELECT id::text AS id, self_ach, mgr_ach FROM pms_kras WHERE appraisal_id = $1`, [a.id])).rows.forEach((r) => { old[r.id] = r; });
  // A form that has no rows of its own yet starts from the Mid Year (else Setting New KRA) rows: keep their ratings by serial number.
  const src = {};
  if (!Object.keys(old).length && rate) {
    (await q(`SELECT k.sno, k.self_ach, k.mgr_ach FROM pms_kras k
               WHERE k.appraisal_id = (SELECT p.id FROM pms_appraisals p WHERE p.emp = $1 AND p.year = $2 AND p.type IN ('Setting New KRA', 'Mid Year Appraisal') AND p.type <> $3
                                        ORDER BY CASE p.type WHEN 'Mid Year Appraisal' THEN 1 ELSE 2 END LIMIT 1)`, [k.emp, k.year, k.type])).rows.forEach((r) => { src[r.sno] = r; });
  }
  const num = (v, label) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e12) throw bad(label + ' must be a number, 0 or more.');
    return n;
  };
  let total = 0;
  const rows = list.map((r, i) => {
    const o = old[String(r && r.id)] || (r && r.id == null ? src[Number(r.sno) || i + 1] : null) || {};
    const threshold = num(r.threshold, 'Threshold');
    if (threshold != null && threshold > 100) throw bad('Threshold cannot be more than 100%.');
    const weight = num(r.weight, 'Weightage') || 0;
    total += weight;
    return {
      sno: i + 1, kra: text(r.kra, 2000), source: text(r.source, 200),
      threshold: threshold == null ? 80 : threshold, target: num(r.target, 'Target'), weight,
      timeline: PMS_TIMELINES.includes(r.timeline) ? r.timeline : 'Ongoing',
      self_ach: acc.self && rate ? num(r.selfAch, 'Self rating') : (o.self_ach == null ? null : Number(o.self_ach)),
      mgr_ach: acc.mgr && rate ? num(r.mgrAch, 'Manager rating') : (o.mgr_ach == null ? null : Number(o.mgr_ach)),
      remarks: text(r.remarks, 1000),
    };
  });
  if (total > 100.0001) throw bad('The weightage total cannot be more than 100.');
  let no = await pmsNumber(k.emp, k.year);
  if (!a) {
    if (k.type === 'Setting New KRA') {
      if (!rows.length) throw bad('Add at least one Key Result Area before saving.');
      if (!no) {
        const n = (await q(`SELECT nextval('pms_seq')::int AS n`)).rows[0].n;
        no = 'PMS' + String((k.y + 1) % 100).padStart(2, '0') + '-' + String((k.y + 2) % 100).padStart(2, '0') + '-' + String(n).padStart(4, '0');
      }
    } else if (!no) {
      throw new HttpError(409, 'Set and save the KRAs for this year first (choose Type: Setting New KRA).');
    }
    const id = no + '-' + (k.type === 'Setting New KRA' ? 'K' : k.type === 'Mid Year Appraisal' ? 'M' : 'A');
    await q(`INSERT INTO pms_appraisals (id, emp, type, year, cycle_no) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (emp, type, year) DO NOTHING`, [id, k.emp, k.type, k.year, no]);
    a = (await q(`SELECT id, status FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  }
  await q(`WITH d AS (DELETE FROM pms_kras WHERE appraisal_id = $1::text)
          INSERT INTO pms_kras (appraisal_id, sno, kra, source, threshold, target, weight, timeline, self_ach, mgr_ach, remarks)
          SELECT $1::text, x.sno, x.kra, x.source, x.threshold, x.target, x.weight, x.timeline, x.self_ach, x.mgr_ach, x.remarks
            FROM jsonb_to_recordset($2::jsonb) AS x(sno int, kra text, source text, threshold numeric, target numeric, weight numeric, timeline text, self_ach numeric, mgr_ach numeric, remarks text)`,
    [a.id, JSON.stringify(rows)]);
  await q(`UPDATE pms_appraisals SET updated_at = now() WHERE id = $1`, [a.id]);
  return pmsPayload(actor, k.emp, k.type, k.year);
});

// Saves the ratings of Page 2. The appraisee can change the self rating, the manager the manager rating and the remarks.
// The list of attributes itself is never taken from the browser: it is copied from the master list (or the Mid Year form).
route('POST', '/api/pms/values/save', async ({ actor, body }) => {
  const k = pmsKey(body, actor);
  if (k.type === 'Setting New KRA') throw bad('Ratings are entered in the Mid Year and Annual appraisals.');
  const acc = await pmsAccess(actor, k.emp);
  const no = await pmsNumber(k.emp, k.year);
  if (!no) throw new HttpError(409, 'Set and save the KRAs for this year first (choose Type: Setting New KRA).');
  let a = (await q(`SELECT id, status, values_weight FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  if (a && a.status !== 'Draft') throw new HttpError(409, 'This appraisal is locked.');
  const base = await valuesBase(k.emp, k.year, k.type, a);
  const sent = {};
  (Array.isArray(body.rows) ? body.rows : []).forEach((r) => { if (r) sent[Number(r.ord)] = r; });
  const num = (v, max, label) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw bad(label + ' must be a number, 0 or more.');
    if (n > max + 1e-9) throw bad(label + ' cannot be more than the marks (' + max + ').');
    return n;
  };
  const keep = (v) => (v == null ? null : Number(v));
  const rows = base.rows.map((b) => {
    const r = sent[b.ord] || {}, rateable = b.marks != null, max = rateable ? Number(b.marks) : 0;
    return {
      ord: b.ord, lvl: b.lvl, code: b.code, label: b.label, marks: rateable ? max : null,
      self_ach: acc.self && rateable && 'selfAch' in r ? num(r.selfAch, max, 'Self rating') : keep(b.selfAch),
      mgr_ach: acc.mgr && rateable && 'mgrAch' in r ? num(r.mgrAch, max, 'Manager rating') : keep(b.mgrAch),
      remarks: acc.mgr && 'remarks' in r ? text(r.remarks, 1000) : (b.remarks || ''),
    };
  });
  if (!a) {
    const id = no + '-' + (k.type === 'Mid Year Appraisal' ? 'M' : 'A');
    await q(`INSERT INTO pms_appraisals (id, emp, type, year, cycle_no) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (emp, type, year) DO NOTHING`, [id, k.emp, k.type, k.year, no]);
    a = (await q(`SELECT id, status, values_weight FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  }
  await q(`WITH d AS (DELETE FROM pms_value_rows WHERE appraisal_id = $1::text)
          INSERT INTO pms_value_rows (appraisal_id, ord, lvl, code, label, marks, self_ach, mgr_ach, remarks)
          SELECT $1::text, x.ord, x.lvl, x.code, x.label, x.marks, x.self_ach, x.mgr_ach, x.remarks
            FROM jsonb_to_recordset($2::jsonb) AS x(ord int, lvl int, code text, label text, marks numeric, self_ach numeric, mgr_ach numeric, remarks text)`,
    [a.id, JSON.stringify(rows)]);
  await q(`UPDATE pms_appraisals SET values_weight = $2, updated_at = now() WHERE id = $1`, [a.id, base.weight]);
  return pmsPayload(actor, k.emp, k.type, k.year);
});

route('GET', '/api/pms/values/master', async ({ actor }) => {
  if (actor.role !== 'admin') throw new HttpError(403, 'Only the admin can change the list of attributes.');
  return valuesMaster();
});

// The master list of attributes. Only the admin can change it; appraisals that already have their own copy are not affected.
route('PUT', '/api/pms/values/master', async ({ actor, body }) => {
  if (actor.role !== 'admin') throw new HttpError(403, 'Only the admin can change the list of attributes.');
  const list = Array.isArray(body.rows) ? body.rows.slice(0, 200) : [];
  const weight = Number(body.weight);
  if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw bad('Weightage must be between 0 and 100.');
  let any = false;
  const rows = list.map((r, i) => {
    const lvl = Number(r && r.lvl);
    if (![1, 2, 3].includes(lvl)) throw bad('Row ' + (i + 1) + ': choose the level.');
    const label = text(r.label, 1000);
    if (!label) throw bad('Row ' + (i + 1) + ': enter the text.');
    let marks = null;
    if (r.marks !== '' && r.marks != null) {
      marks = Number(r.marks);
      if (!Number.isFinite(marks) || marks < 0 || marks > 100) throw bad('Row ' + (i + 1) + ': marks must be between 0 and 100.');
      any = true;
    }
    return { ord: i + 1, lvl, code: text(r.code, 10), label, marks };
  });
  if (!any) throw bad('Give marks to at least one line, otherwise there is nothing to rate.');
  await q(`WITH d AS (DELETE FROM pms_value_master),
               s AS (INSERT INTO pms_settings (key, value) VALUES ('values_weightage', $2::text) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value)
          INSERT INTO pms_value_master (ord, lvl, code, label, marks)
          SELECT x.ord, x.lvl, x.code, x.label, x.marks FROM jsonb_to_recordset($1::jsonb) AS x(ord int, lvl int, code text, label text, marks numeric)`,
    [JSON.stringify(rows), String(weight)]);
  return valuesMaster();
});

route('PUT', '/api/policy/:grade', async ({ actor, params, body }) => {
  if (actor.role !== 'admin') throw new HttpError(403, 'Only finance can change the policy.');
  const hotel = num(body.hotel), da = num(body.da);
  if (!(hotel >= 0) || !(da >= 0)) throw bad('Enter amounts of zero or more.');
  const r = await q(`UPDATE policy SET hotel = $2, da = $3 WHERE grade = $1 RETURNING grade`, [params.grade, hotel, da]);
  if (!r.rows[0]) throw new HttpError(404, 'Grade not found.');
  return { grade: r.rows[0].grade };
});

// ---------- sign-in ----------
const SESSION_HOURS = 12;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const attempts = new Map();                 // sign-in failures per address + employee code
const WINDOW_MS = 15 * 60 * 1000;
const tooMany = (k) => { const a = attempts.get(k); return !!a && a.n >= 5 && Date.now() - a.first < WINDOW_MS; };
const noteFail = (k) => { const a = attempts.get(k); if (!a || Date.now() - a.first >= WINDOW_MS) attempts.set(k, { n: 1, first: Date.now() }); else a.n += 1; };

function cookieValue(req, name) {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function setSessionCookie(res, token, seconds) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `td_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${secure}`);
}
async function getSession(req) {
  const token = cookieValue(req, 'td_session');
  if (!token) return null;
  const tokenHash = sha(token);
  const r = await q(
    `SELECT u.id, u.code, u.name, u.role, u.grade, u.dept, u.desig, u.must_change AS "mustChange", COALESCE(u.email, '') AS email
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash]);
  return r.rows[0] ? { tokenHash, user: r.rows[0] } : null;
}

route('POST', '/api/login', async ({ body, req, res }) => {
  const code = text(body.code, 20);
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  const key = (req.socket.remoteAddress || '') + '|' + code.toLowerCase();
  if (tooMany(key)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  const r = await q(`SELECT id, password_hash FROM users WHERE code = $1`, [code]);
  const u = r.rows[0];
  const ok = await verifyPassword(password, u ? u.password_hash : null);
  if (!u || !ok) { noteFail(key); throw new HttpError(401, 'Employee code or password is incorrect.'); }
  attempts.delete(key);
  await q(`DELETE FROM sessions WHERE expires_at < now()`);
  const token = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours')`, [sha(token), u.id]);
  setSessionCookie(res, token, SESSION_HOURS * 3600);
  const me = await q(`SELECT id, code, name, role, grade, dept, desig, must_change AS "mustChange" FROM users WHERE id = $1`, [u.id]);
  return { user: me.rows[0] };
});

route('POST', '/api/logout', async ({ session, res }) => {
  if (session) await q(`DELETE FROM sessions WHERE token_hash = $1`, [session.tokenHash]);
  setSessionCookie(res, '', 0);
  return { ok: true };
});

route('GET', '/api/me', async ({ actor }) => actor);

route('POST', '/api/password', async ({ actor, session, body }) => {
  const current = typeof body.current === 'string' ? body.current : '';
  const next = typeof body.next === 'string' ? body.next : '';
  const r = await q(`SELECT password_hash FROM users WHERE id = $1`, [actor.id]);
  if (!(await verifyPassword(current, r.rows[0] && r.rows[0].password_hash))) throw bad('Your current password is not correct.');
  const problem = passwordProblem(next, current);
  if (problem) throw bad(problem);
  await q(`UPDATE users SET password_hash = $2, must_change = false WHERE id = $1`, [actor.id, await hashPassword(next)]);
  await q(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [actor.id, session.tokenHash]);
  return { ok: true };
});

route('POST', '/api/reset', async ({ actor }) => {
  if (process.env.ALLOW_RESET !== 'true') throw new HttpError(403, 'Reset is turned off on this server.');
  if (actor.role !== 'admin') throw new HttpError(403, 'Only finance can reset the data.');
  await pool.query(fs.readFileSync(path.join(__dirname, 'db', 'seed.sql'), 'utf8'));
  await setDefaultPasswords((t, p) => pool.query(t, p));
  return { ok: true };
});

// ---------- server ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(bad('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

const OPEN = new Set(['/api/health', '/api/login', '/api/logout']);
const ALLOWED_WHILE_PASSWORD_PENDING = new Set(['/api/me', '/api/password']);

async function handleApi(req, res, pathname) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    // A custom header cannot be sent by another site's form or image, which blocks cross-site requests.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'travel-desk') throw new HttpError(403, 'Request blocked.');
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req, /^\/api\/claims\/[^/]+\/files$/.test(pathname) ? 8000000 : 100000);
    const session = pathname === '/api/health' ? null : await getSession(req);
    const actor = session ? session.user : null;
    if (!OPEN.has(pathname)) {
      if (!actor) throw new HttpError(401, 'Sign in to continue.');
      if (actor.mustChange && !ALLOWED_WHILE_PASSWORD_PENDING.has(pathname)) throw new HttpError(403, 'Change your password to continue.');
    }
    const out = await r.handler({ actor, session, params, body, req, res });
    if (out && out.raw) {
      res.writeHead(200, { 'Content-Type': out.mime, 'Content-Disposition': 'inline; filename="' + out.name + '"', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' });
      return res.end(out.raw);
    }
    return send(res, 200, out);
  }
  throw new HttpError(404, 'Not found.');
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set. Copy .env.example to .env and edit it.'); process.exit(1); }
  try {
    const t = await q(`SELECT to_regclass('public.expenses') IS NOT NULL AS ready`);
    if (!t.rows[0].ready) { console.error('The tables are missing. Run: npm run db:init'); process.exit(1); }
    await q(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
    await q(`UPDATE users SET email = lower(split_part(name, ' ', 1)) || '@example.com' WHERE email IS NULL`);
    await q(`UPDATE users u SET l4_email = (SELECT h.email FROM users h WHERE h.role = 'manager' AND h.dept = u.dept AND h.id <> u.id ORDER BY h.id LIMIT 1) WHERE u.l4_email IS NULL`);
    await q(`UPDATE users u SET reporting_to = (SELECT h.id FROM users h WHERE h.role = 'manager' AND h.dept = u.dept AND h.id <> u.id ORDER BY h.id LIMIT 1) WHERE u.reporting_to IS NULL`);
  } catch (e) { console.error('Cannot connect to PostgreSQL:', e.message); process.exit(1); }
  server.listen(PORT, () => {
    console.log(`Travel Desk is running at http://localhost:${PORT}`);
    console.log(mail.configured()
      ? `E-mail is ON: sending through ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} as ${process.env.SMTP_USER || process.env.MAIL_FROM}`
      : 'E-mail is OFF: SMTP_HOST or MAIL_FROM is missing in the .env file, so no notifications are sent.');
  });
})();
