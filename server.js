'use strict';
require('./lib/env');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const mail = require('./lib/mail');
const { hashPassword, verifyPassword, passwordProblem, setDefaultPasswords } = require('./lib/auth');

const PORT = Number(process.env.PORT) || 3000;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set. Copy .env.example to .env and edit it.'); process.exit(1); }
const pool = db.createPool();                       // local PostgreSQL or Supabase: see lib/db.js
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
  // Someone the appraisal was sent to (L1 to L4) can open it too.
  const appr = self || mgr ? false : !!(await q(`SELECT 1 FROM pms_appraisals WHERE emp = $1 AND $2::text IN (l1, l2, l3, l4) LIMIT 1`, [empId, actor.id])).rows[0];
  if (!self && !mgr && !appr) throw new HttpError(403, "You can open only your own appraisal, your team's, or one that was sent to you.");
  return { self, mgr, appr };
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
                               COALESCE(m.name, '') AS manager, u.reporting_to AS "reportingTo"
                          FROM users u LEFT JOIN users m ON m.id = u.reporting_to WHERE u.id = $1`, [empId])).rows[0];
  // The people whose form you can open: your reports, and anyone whose appraisal was sent to you ("waiting" = it is your turn now).
  const team = (await q(`SELECT u.id, u.name,
                                (SELECT count(*)::int FROM pms_appraisals p WHERE p.emp = u.id AND p.stage BETWEEN 1 AND 4
                                    AND (CASE p.stage WHEN 1 THEN p.l1 WHEN 2 THEN p.l2 WHEN 3 THEN p.l3 ELSE p.l4 END) = $1::text) AS waiting
                           FROM users u
                          WHERE u.id <> $1::text AND (u.reporting_to = $1::text OR EXISTS (SELECT 1 FROM pms_appraisals p WHERE p.emp = u.id AND $1::text IN (p.l1, p.l2, p.l3, p.l4)))
                          ORDER BY u.name`, [actor.id])).rows;
  const no = await pmsNumber(empId, year);
  const a = (await q(`SELECT id, status, stage, l1, l2, l3, l4, submitted_at, values_weight, cmt_appraiser, cmt_action, cmt_reviewer, cmt_appraisee, cmt_hr FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [empId, type, year])).rows[0];
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
  const timelines = await pmsTimelines(actor);
  const comments = { appraiser: a ? a.cmt_appraiser : '', action: a ? a.cmt_action : '', reviewer: a ? a.cmt_reviewer : '', appraisee: a ? a.cmt_appraisee : '', hr: a ? a.cmt_hr : '' };
  const R = pmsRights(actor, acc, a);
  const approval = await pmsApprovalInfo(actor, acc, emp, a, no);
  return { employee: emp, team, appraisal: { id: a ? a.id : null, no, type, year, status: a ? a.status : 'Draft', stage: a ? a.stage : 0 }, kras, can: { self: R.self, mgr: R.mgr, rev: R.rev, hr: R.hr }, blocked, values, comments, timelines, approval };
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
  let a = (await q(`SELECT id, status, stage, l1, l2, l3, l4 FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  const R = pmsRights(actor, acc, a);
  if (!R.self && !R.mgr) throw pmsNoEdit(a);
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
      self_ach: R.self && rate ? num(r.selfAch, 'Self rating') : (o.self_ach == null ? null : Number(o.self_ach)),
      mgr_ach: R.mgr && rate ? num(r.mgrAch, 'Manager rating') : (o.mgr_ach == null ? null : Number(o.mgr_ach)),
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
  let a = (await q(`SELECT id, status, stage, l1, l2, l3, l4, values_weight FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  const R = pmsRights(actor, acc, a);
  if (!R.self && !R.mgr) throw pmsNoEdit(a);
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
      self_ach: R.self && rateable && 'selfAch' in r ? num(r.selfAch, max, 'Self rating') : keep(b.selfAch),
      mgr_ach: R.mgr && rateable && 'mgrAch' in r ? num(r.mgrAch, max, 'Manager rating') : keep(b.mgrAch),
      remarks: R.mgr && 'remarks' in r ? text(r.remarks, 1000) : (b.remarks || ''),
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

// ----- Page 3: comments -----
// The manager (L1) writes the Appraiser comments and the specific action; the employee writes the Appraisee comments;
// the HOD (L2) or the Function Head (L3) writes the Reviewer comment on their turn; the CHRO (L4) writes the HR comment on their turn.
// Each person's own boxes are saved and the other boxes are kept as they are.
const PMS_TYPE_CODE = { 'Setting New KRA': 'K', 'Mid Year Appraisal': 'M', 'Annual Appraisal': 'A' };
route('POST', '/api/pms/comments/save', async ({ actor, body }) => {
  const k = pmsKey(body, actor);
  const acc = await pmsAccess(actor, k.emp);
  const no = await pmsNumber(k.emp, k.year);
  if (!no) throw new HttpError(409, 'Set and save the KRAs for this year first (this creates the PMS number).');
  let a = (await q(`SELECT id, status, stage, l1, l2, l3, l4 FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  const R = pmsRights(actor, acc, a);
  if (!R.self && !R.mgr && !R.rev && !R.hr) throw pmsNoEdit(a);
  const c = body.comments && typeof body.comments === 'object' ? body.comments : {};
  const sent = (f) => typeof c[f] === 'string';
  if (['appraiser', 'action', 'appraisee', 'reviewer', 'hr'].some((f) => sent(f) && c[f].length > 4000)) throw bad('Each comment can have up to 4000 characters.');
  if (!a) {
    await q(`INSERT INTO pms_appraisals (id, emp, type, year, cycle_no) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (emp, type, year) DO NOTHING`, [no + '-' + PMS_TYPE_CODE[k.type], k.emp, k.type, k.year, no]);
    a = (await q(`SELECT id, status FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  }
  const set = [], vals = [a.id];
  const put = (col, v) => { vals.push(v.trim()); set.push(col + ' = $' + vals.length); };
  if (R.mgr && sent('appraiser')) put('cmt_appraiser', c.appraiser);
  if (R.mgr && sent('action')) put('cmt_action', c.action);
  if (R.self && sent('appraisee')) put('cmt_appraisee', c.appraisee);
  if (R.rev && sent('reviewer')) put('cmt_reviewer', c.reviewer);
  if (R.hr && sent('hr')) put('cmt_hr', c.hr);
  if (set.length) await q(`UPDATE pms_appraisals SET ${set.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  return pmsPayload(actor, k.emp, k.type, k.year);
});

// ----- Page 6: sending for approval -----
// The chain is L1 Manager, L2 HOD, L3 Function Head (chosen by the employee when submitting) and L4 CHRO (one person for everyone,
// set by finance). A level that is left empty is skipped. L5 and L6 are not used.
// stage: 0 = with the employee, 1-4 = waiting for that level, 5 = approved.
const PMS_LEVEL_NAMES = ['Manager', 'HOD', 'Function Head', 'CHRO'];
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

// What the person may change on this appraisal right now.
//   draft: the employee (own ratings, appraisee comment) and the manager (manager ratings, appraiser comment, action), as always
//   with L1: only L1; with L2 or L3: only the Reviewer comment; with L4: only the HR comment; approved: nobody.
function pmsRights(actor, acc, a) {
  const stage = a ? a.stage : 0;
  const at = (n) => !!a && a['l' + n] === actor.id;
  if (stage === 0) return { self: acc.self, mgr: acc.mgr || at(1), rev: false, hr: false };
  if (stage === 1) return { self: false, mgr: at(1), rev: false, hr: false };
  return { self: false, mgr: false, rev: (stage === 2 && at(2)) || (stage === 3 && at(3)), hr: stage === 4 && at(4) };
}
function pmsNoEdit(a) {
  if (a && a.stage === 5) return new HttpError(409, 'This appraisal is approved, so it cannot be changed.');
  if (a && a.stage > 0) return new HttpError(409, 'This appraisal has been sent for approval and is with someone else now, so you cannot change it.');
  return new HttpError(403, 'You cannot change this appraisal.');
}

// The CHRO (one for everyone) and the Function Head of each department, set by the finance admin.
async function pmsApprovers() {
  const rows = (await q(`SELECT key, value FROM pms_settings WHERE key IN ('chro', 'fh')`)).rows;
  let chro = '', fh = {};
  rows.forEach((r) => { if (r.key === 'chro') chro = r.value; if (r.key === 'fh') { try { fh = JSON.parse(r.value) || {}; } catch (e) { fh = {}; } } });
  return { chro, fh };
}
// The usual people for an employee: the reporting manager, that person's manager, the Function Head of the department, the CHRO.
// Nobody is listed twice, and the employee is never their own approver.
async function pmsDefaultChain(emp, st) {
  const seen = new Set([emp.id]);
  const pick = (id) => { if (!id || seen.has(id)) return null; seen.add(id); return id; };
  const up = emp.reportingTo ? ((await q(`SELECT reporting_to FROM users WHERE id = $1`, [emp.reportingTo])).rows[0] || {}).reporting_to : null;
  const l1 = pick(emp.reportingTo), l2 = pick(up), l3 = pick(st.fh[emp.dept]);
  const l4 = st.chro && !seen.has(st.chro) ? st.chro : null;
  return [l1, l2, l3, l4];
}

// Everything Page 4 and Page 6 need to know about the approval of one appraisal.
async function pmsApprovalInfo(actor, acc, emp, a, no) {
  const stage = a ? a.stage : 0;
  const st = await pmsApprovers();
  let ids = a ? [a.l1, a.l2, a.l3, a.l4] : [null, null, null, null];
  if (stage === 0 && !ids[0]) ids = await pmsDefaultChain(emp, st);
  const known = ids.filter(Boolean);
  const people = {};
  if (known.length) (await q(`SELECT id, name, COALESCE(email, '') AS email FROM users WHERE id = ANY($1::text[])`, [known])).rows.forEach((u) => { people[u.id] = u; });
  const chain = ids.map((id, i) => ({ level: i + 1, role: PMS_LEVEL_NAMES[i], id: id || '', name: id && people[id] ? people[id].name : '', email: id && people[id] ? people[id].email : '' }));
  const hist = a ? (await q(`SELECT h.level, h.action, h.note, h.at, u.name AS by FROM pms_approvals h JOIN users u ON u.id = h.actor WHERE h.appraisal_id = $1 ORDER BY h.id`, [a.id])).rows : [];
  const lastSub = hist.map((h) => h.action).lastIndexOf('submitted');
  const since = lastSub < 0 ? hist : hist.slice(lastSub);
  const lastAct = since[since.length - 1];
  const wasReturned = !!lastAct && lastAct.action === 'returned';
  const steps = chain.map((c) => {
    if (!c.id) return { level: c.level, email: '', status: '', title: '' };
    const h = since.filter((x) => x.level === c.level).pop();
    let status = '';
    if (wasReturned) status = lastAct.level === c.level ? 'Returned' : '';
    else if (h) status = h.action === 'approved' ? 'Approved' : 'Returned';
    else if (stage === c.level) status = 'Submitted';
    return { level: c.level, email: c.email || c.name, status, title: h ? h.by + ' on ' + fmtDate(h.at) + (h.note ? ': ' + h.note : '') : '' };
  });
  const holderId = stage >= 1 && stage <= 4 ? ids[stage - 1] : null;
  const mine = !!holderId && holderId === actor.id;
  const next = stage >= 1 && stage <= 4 ? [1, 2, 3, 4].find((n) => n > stage && ids[n - 1]) : null;
  const canPick = stage === 0 && acc.self && !!a;
  const last = hist[hist.length - 1];
  let text;
  if (!no) text = 'Save the goals on Page 1 first. That creates the PMS number.';
  else if (!a) text = 'Save this form first, then send it for approval.';
  else if (stage === 5) text = 'Approved on ' + fmtDate(last && last.at) + '.';
  else if (stage === 0 && wasReturned) text = 'Sent back by ' + lastAct.by + ' on ' + fmtDate(lastAct.at) + ': ' + lastAct.note + (acc.self ? ' Make your changes and submit it again.' : '');
  else if (stage === 0) text = acc.self ? 'Choose the approvers and press Submit. The appraisal goes to L1 first.' : 'Not submitted yet. The employee has not sent it for approval.';
  else if (mine) text = next ? 'This appraisal is with you. Add your part, then press Submit to send it to L' + next + ' (' + chain[next - 1].name + ').' : 'This appraisal is with you. Press Approve to approve it. This is the last step.';
  else text = 'With L' + stage + ' ' + PMS_LEVEL_NAMES[stage - 1] + ' (' + (chain[stage - 1].name || 'nobody') + ') since ' + fmtDate(last && last.at) + '.';
  let options = null, settings = null;
  if (canPick) options = (await q(`SELECT id, name, COALESCE(email, '') AS email FROM users WHERE id <> $1 ORDER BY name`, [emp.id])).rows;
  if (actor.role === 'admin') {
    const us = (await q(`SELECT id, name, COALESCE(email, '') AS email, dept FROM users ORDER BY name`)).rows;
    settings = { chro: st.chro, fh: st.fh, depts: [...new Set(us.map((u) => u.dept))].sort(), users: us };
  }
  return { stage, chain, steps, finalStatus: stage === 5 ? 'Approved' : '', canPick, canSubmit: (stage === 0 && acc.self && !!a) || mine, canReturn: mine, final: mine && !next, text, options, settings };
}

// ----- e-mails for the approval flow -----
async function notifyPms(a, event, toId, by, note) {
  try {
    const emp = (await q(`SELECT name FROM users WHERE id = $1`, [a.emp])).rows[0] || { name: '' };
    const to = (await q(`SELECT name, COALESCE(email, '') AS email FROM users WHERE id = $1`, [toId])).rows[0];
    if (!to || !to.email) return;
    const what = a.type + ' ' + a.year + ' (' + (a.cycle_no || a.id) + ')';
    const link = '\n\nOpen Travel Desk: ' + appUrl() + '\n';
    let subject, body;
    if (event === 'waiting') {
      subject = (a.cycle_no || a.id) + ': ' + emp.name + ' - waiting for you';
      body = 'Hello ' + to.name + ',\n\n' + emp.name + "'s " + what + ' has been sent to you by ' + by + '.' +
        '\n\nTo review it: open Performance, choose ' + emp.name + ' in "Name of Employee" (marked "waiting for you"), add your part and press Submit on Page 6.' + link;
    } else if (event === 'approved') {
      subject = (a.cycle_no || a.id) + ': approved';
      body = 'Hello ' + to.name + ',\n\nYour ' + what + ' has been approved. The last approval was given by ' + by + '.' + link;
    } else {
      subject = (a.cycle_no || a.id) + ': sent back to you';
      body = 'Hello ' + to.name + ',\n\n' + by + ' has sent your ' + what + ' back to you.\n\nReason: ' + note + '\n\nPlease make the changes and submit it again.' + link;
    }
    await queueMail(a.id, to.email, subject, body);
  } catch (e) { console.error('PMS notification failed: ' + e.message); }
}

route('POST', '/api/pms/approval/submit', async ({ actor, body }) => {
  const k = pmsKey(body, actor);
  const acc = await pmsAccess(actor, k.emp);
  const a = (await q(`SELECT * FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  if (!a) throw new HttpError(409, 'Save this form first. Nothing has been saved for it yet.');
  if (a.stage === 5) throw new HttpError(409, 'This appraisal is already approved.');
  const changed = () => new HttpError(409, 'Someone else just changed this appraisal. Reopen it and try again.');
  if (a.stage === 0) {
    // The employee sends it for the first time (or again after it was sent back).
    if (!acc.self) throw new HttpError(403, 'Only the employee can send the appraisal for approval.');
    const g = (await q(`SELECT count(*)::int AS n, COALESCE(sum(weight), 0) AS w FROM pms_kras WHERE appraisal_id = $1`, [a.id])).rows[0];
    if (!g.n) throw new HttpError(409, 'Save the KRA table on Page 1 before you submit.');
    if (Math.abs(Number(g.w) - 100) > 0.0001) throw new HttpError(409, 'The weightage total on Page 1 must be 100 before you submit (it is ' + Number(g.w) + ').');
    const st = await pmsApprovers();
    if (!st.chro) throw new HttpError(409, 'The CHRO has not been set yet. Ask the finance admin to set it at the bottom of Page 6.');
    const [l1, l2, l3] = [body.l1, body.l2, body.l3].map((v) => text(v, 20) || null);
    if (!l1) throw bad('Choose the L1 Manager.');
    const chosen = [l1, l2, l3].filter(Boolean);
    if (new Set(chosen).size !== chosen.length) throw bad('Each level needs a different person.');
    if (chosen.includes(k.emp)) throw bad('You cannot be your own approver.');
    if ((await q(`SELECT id FROM users WHERE id = ANY($1::text[])`, [chosen])).rows.length !== chosen.length) throw bad('Choose the approvers from the list.');
    const l4 = st.chro !== k.emp && !chosen.includes(st.chro) ? st.chro : null;
    const r = await q(`UPDATE pms_appraisals SET stage = 1, status = 'Submitted', l1 = $2, l2 = $3, l3 = $4, l4 = $5, submitted_at = now(), updated_at = now() WHERE id = $1 AND stage = 0`, [a.id, l1, l2, l3, l4]);
    if (!r.rowCount) throw changed();
    await q(`INSERT INTO pms_approvals (appraisal_id, level, actor, action) VALUES ($1, 0, $2, 'submitted')`, [a.id, actor.id]);
    notifyPms(a, 'waiting', l1, actor.name);
  } else {
    // An approver sends it on, or gives the final approval.
    const n = a.stage;
    if (a['l' + n] !== actor.id) throw new HttpError(403, 'This appraisal is not waiting for you.');
    const next = [1, 2, 3, 4].find((m) => m > n && a['l' + m]);
    const r = await q(`UPDATE pms_appraisals SET stage = $2, status = $3, updated_at = now() WHERE id = $1 AND stage = $4`, [a.id, next || 5, next ? 'Submitted' : 'Approved', n]);
    if (!r.rowCount) throw changed();
    await q(`INSERT INTO pms_approvals (appraisal_id, level, actor, action, note) VALUES ($1, $2, $3, 'approved', $4)`, [a.id, n, actor.id, text(body.note, 1000)]);
    if (next) notifyPms(a, 'waiting', a['l' + next], actor.name);
    else notifyPms(a, 'approved', a.emp, actor.name);
  }
  return pmsPayload(actor, k.emp, k.type, k.year);
});

route('POST', '/api/pms/approval/return', async ({ actor, body }) => {
  const k = pmsKey(body, actor);
  await pmsAccess(actor, k.emp);
  const a = (await q(`SELECT * FROM pms_appraisals WHERE emp = $1 AND type = $2 AND year = $3`, [k.emp, k.type, k.year])).rows[0];
  const n = a ? a.stage : 0;
  if (!a || n < 1 || n > 4 || a['l' + n] !== actor.id) throw new HttpError(403, 'This appraisal is not waiting for you.');
  const note = text(body.note, 1000);
  if (!note) throw bad('Write the reason for sending it back.');
  const r = await q(`UPDATE pms_appraisals SET stage = 0, status = 'Draft', updated_at = now() WHERE id = $1 AND stage = $2`, [a.id, n]);
  if (!r.rowCount) throw new HttpError(409, 'Someone else just changed this appraisal. Reopen it and try again.');
  await q(`INSERT INTO pms_approvals (appraisal_id, level, actor, action, note) VALUES ($1, $2, $3, 'returned', $4)`, [a.id, n, actor.id, note]);
  notifyPms(a, 'returned', a.emp, actor.name, note);
  return pmsPayload(actor, k.emp, k.type, k.year);
});

// The Approval Center: everything that is waiting for the signed-in person right now, oldest first.
// canSee: HODs and finance always have the tab; anyone else gets it once they are named as an approver on an appraisal.
route('GET', '/api/pms/center', async ({ actor }) => {
  const rows = (await q(`SELECT p.emp, p.type, p.year, p.cycle_no, p.stage, p.submitted_at, u.name, u.dept
                           FROM pms_appraisals p JOIN users u ON u.id = p.emp
                          WHERE p.stage BETWEEN 1 AND 4
                            AND (CASE p.stage WHEN 1 THEN p.l1 WHEN 2 THEN p.l2 WHEN 3 THEN p.l3 ELSE p.l4 END) = $1::text
                          ORDER BY p.submitted_at, u.name`, [actor.id])).rows;
  const canSee = actor.role !== 'employee' || rows.length > 0 ||
    !!(await q(`SELECT 1 FROM pms_appraisals WHERE $1::text IN (l1, l2, l3, l4) LIMIT 1`, [actor.id])).rows[0];
  return {
    canSee,
    items: rows.map((r) => ({ emp: r.emp, name: r.name, dept: r.dept, type: r.type, year: r.year, no: r.cycle_no || '', level: r.stage, levelName: PMS_LEVEL_NAMES[r.stage - 1], submittedAt: r.submitted_at })),
  };
});

// Finance sets the CHRO (one for everyone) and the Function Head of each department.
route('POST', '/api/pms/approvers/save', async ({ actor, body }) => {
  if (actor.role !== 'admin') throw new HttpError(403, 'Only the admin can set the CHRO and the Function Heads.');
  const us = (await q(`SELECT id, dept FROM users`)).rows;
  const ids = new Set(us.map((u) => u.id)), depts = new Set(us.map((u) => u.dept));
  const chro = text(body.chro, 20);
  if (chro && !ids.has(chro)) throw bad('Choose the CHRO from the list.');
  const fhIn = body.fh && typeof body.fh === 'object' ? body.fh : {};
  const fh = {};
  Object.keys(fhIn).forEach((d) => {
    const v = text(fhIn[d], 20);
    if (!depts.has(d)) throw bad('Unknown department: ' + d.slice(0, 40));
    if (v && !ids.has(v)) throw bad('Choose the Function Head of ' + d + ' from the list.');
    if (v) fh[d] = v;
  });
  if (chro) await q(`INSERT INTO pms_settings (key, value) VALUES ('chro', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [chro]);
  else await q(`DELETE FROM pms_settings WHERE key = 'chro'`);
  await q(`INSERT INTO pms_settings (key, value) VALUES ('fh', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(fh)]);
  const k = pmsKey(body, actor);
  return pmsPayload(actor, k.emp, k.type, k.year);
});

// ----- Page 5: timelines -----
// Two tables of activities and dates. The finance admin can edit them; everyone else only reads them. The edited copy is kept
// in pms_settings under the key 'timelines'. In a text, {kraFy} and {apprFy} are replaced by the two years. In an action,
// a line that starts with ~ is shown indented.
const TL_DEFAULT = {
  kraFy: '25-26', apprFy: '24-25',
  tables: [
    { rows: [
      { action: ['Fill KRA form for next year-FY {kraFy}( KRA form attached) and submit'], by: 'Employee', to: 'Immediate Manager', date: '8th March(Saturday)' },
      { action: ['Review and submit to next level'], by: 'Immediate Manager', to: 'HOD / Function head /ED/MD (who-ever is applicable)', date: '22nd March( Saturday)' },
      { action: ['Finalize KRAs for entire team and submit'], by: 'HOD / Function Head/ BU Head', to: 'HR', date: '5th April( Saturday)' },
      { action: ['Sign off on all FY {kraFy} KRAs for all SH team members'], by: 'HOD / Function Head/ BU Head + CHRO', to: '', date: '19th April( Saturday)' },
    ] },
    { rows: [
      { action: ['Complete Self-Assessment and submit:', '~i) Section A - Fill up Column F (Actual Self', '~ii) Section B - Fill up Column C (Actual Self'], by: 'Employee', to: 'Manager', date: '25th March' },
      { action: ['A) Fill in the below sections :', '~i) Section A - Fill up Column G - J (Actual', '~ii) Section B - Fill up Column D & E (Actual', 'B) Schedule Performance review discussion for FY 23-24', 'C) Share performance + development feedback with the Appraisee', 'D) Enter Comments as Appraiser / Reviewer and specific actions', 'E) Submit Completed Appraisal in SOFT COPY'], by: 'Immediate Manager / Appraiser', to: 'HOD / Function head /ED/MD (who-ever is applicable)', date: '10th April' },
      { action: ['Submit all Appraisal forms (soft copies) for respective teams'], by: 'HOD / Function Head /ED/MD (who-ever is applicable)', to: 'HR', date: '19th April' },
      { action: ['Calibration + normalization exercise to arrive at final performance scores. ( This will happen for departments submitting within timelines)'], by: 'HOD / Function Head/ BU Head + CHRO', to: '', date: '1st Week May' },
    ] },
  ],
};
async function pmsTimelines(actor) {
  const r = (await q(`SELECT value FROM pms_settings WHERE key = 'timelines'`)).rows[0];
  let config = TL_DEFAULT, custom = false;
  if (r) { try { config = JSON.parse(r.value); custom = true; } catch (e) { config = TL_DEFAULT; } }
  return { config, custom, canEdit: actor.role === 'admin' };
}
function cleanTimelines(b) {
  if (!b || typeof b !== 'object') throw bad('The timelines are missing.');
  const fy = (v) => { if (typeof v !== 'string' || !/^\d{2}-\d{2}$/.test(v.trim())) throw bad('Write each year like 25-26.'); return v.trim(); };
  if (!Array.isArray(b.tables) || b.tables.length !== 2) throw bad('There must be two tables.');
  const tables = b.tables.map((t, ti) => {
    if (!t || !Array.isArray(t.rows) || t.rows.length < 1 || t.rows.length > 30) throw bad('Table ' + (ti + 1) + ' needs between 1 and 30 rows.');
    return { rows: t.rows.map((r, ri) => {
      const where = 'Table ' + (ti + 1) + ', row ' + (ri + 1) + ': ';
      if (!r || !Array.isArray(r.action)) throw bad(where + 'the action is missing.');
      const action = r.action.filter((l) => typeof l === 'string' && l.trim() !== '').map((l) => l.trim().slice(0, 300));
      if (!action.length) throw bad(where + 'the action is empty.');
      if (action.length > 12) throw bad(where + 'an action can have up to 12 lines.');
      return { action, by: text(r.by, 200), to: text(r.to, 200), date: text(r.date, 100) };
    }) };
  });
  return { kraFy: fy(b.kraFy), apprFy: fy(b.apprFy), tables };
}
route('POST', '/api/pms/timelines/save', async ({ actor, body }) => {
  if (actor.role !== 'admin') throw new HttpError(403, 'Only the admin can change the timelines.');
  const config = cleanTimelines(body.config);
  await q(`INSERT INTO pms_settings (key, value) VALUES ('timelines', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(config)]);
  return pmsTimelines(actor);
});
route('POST', '/api/pms/timelines/reset', async ({ actor }) => {
  if (actor.role !== 'admin') throw new HttpError(403, 'Only the admin can change the timelines.');
  await q(`DELETE FROM pms_settings WHERE key = 'timelines'`);
  return pmsTimelines(actor);
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
  } catch (e) { console.error('Cannot connect to the database at ' + db.describe() + ':\n' + db.explain(e)); process.exit(1); }
  server.listen(PORT, () => {
    console.log(`Travel Desk is running at http://localhost:${PORT}`);
    console.log('Database: ' + db.describe() + (db.isSupabaseHost((new URL(process.env.DATABASE_URL)).hostname) ? ' (Supabase)' : ''));
    console.log(mail.configured()
      ? `E-mail is ON: sending through ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} as ${process.env.SMTP_USER || process.env.MAIL_FROM}`
      : 'E-mail is OFF: SMTP_HOST or MAIL_FROM is missing in the .env file, so no notifications are sent.');
  });
})();
