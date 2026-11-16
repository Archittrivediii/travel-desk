'use strict';
// One place that creates the database connection pool, so the server and every script connect the same way.
// Works with a local PostgreSQL and with Supabase (or any hosted PostgreSQL).
//
//   DATABASE_URL         connection string (required)
//   DATABASE_SSL         true | false. Default: on for Supabase and for any URL that asks for sslmode=require.
//   DATABASE_SSL_CA      optional path to the provider's CA certificate. When set, the certificate is fully verified.
//   DATABASE_POOL_MAX    most connections the server keeps open (default 10)
require('./env');
const fs = require('fs');
const { Pool, types } = require('pg');

types.setTypeParser(1082, (v) => v);              // date -> 'YYYY-MM-DD' string
types.setTypeParser(1700, (v) => parseFloat(v));  // numeric -> number

const isOff = (v) => /^(false|off|no|0)$/i.test(String(v || '').trim());
const isOn = (v) => /^(true|on|yes|1)$/i.test(String(v || '').trim());

function parseUrl(raw) {
  try { return new URL(raw); } catch (e) { return null; }
}

function isSupabaseHost(host) {
  return /(^|\.)supabase\.(co|com)$/i.test(host || '');
}

// Supabase's certificate is signed by Supabase's own authority, which Node does not know about. So unless a CA file is
// given, the connection is still encrypted but the certificate is not checked against a trusted authority.
function sslFor(raw) {
  const u = parseUrl(raw);
  const host = u ? u.hostname : '';
  const flag = process.env.DATABASE_SSL;
  const mode = u ? (u.searchParams.get('sslmode') || '').toLowerCase() : '';
  if (isOff(flag) || (!isOn(flag) && mode === 'disable')) return false;
  const wanted = isOn(flag) || isSupabaseHost(host) || /^(require|verify-ca|verify-full)$/.test(mode);
  if (!wanted) return false;
  const caFile = process.env.DATABASE_SSL_CA;
  if (caFile) return { ca: fs.readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

// The pg driver lets sslmode= in the URL override the ssl setting above, so those query options are removed here.
// Only the part after "?" is touched: the user, password and host are passed on exactly as they were written.
const STRIP = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'pgbouncer', 'supa'];
function cleanUrl(raw) {
  const q = String(raw).indexOf('?');
  if (q < 0) return raw;
  const params = new URLSearchParams(raw.slice(q + 1));
  if (!STRIP.some((k) => params.has(k))) return raw;
  STRIP.forEach((k) => params.delete(k));
  const rest = params.toString();
  return raw.slice(0, q) + (rest ? '?' + rest : '');
}

// Mistakes that are easy to make when the string is copied from the Supabase dashboard, caught before any network call.
// Returns a message in plain words, or '' when the string looks fine.
function checkUrl(raw) {
  if (!raw) return 'DATABASE_URL is not set. Copy .env.example to .env and edit it.';
  if (/\[?YOUR-PASSWORD\]?|<password>|\[password\]/i.test(raw)) {
    return 'DATABASE_URL still has the placeholder for the password. Replace [YOUR-PASSWORD] (including the square brackets) with your real database password.';
  }
  const u = parseUrl(raw);
  if (!u || !u.hostname) {
    return 'DATABASE_URL is not a valid address. A password with symbols such as @ : / # ? [ ] breaks it. Use a password of letters and numbers only'
      + ' (in Supabase: Project Settings > Database > reset the password), or write each symbol percent-encoded (for example @ becomes %40).';
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return 'DATABASE_URL must start with postgresql://';
  return '';
}

function createPool(raw, opts) {
  const url = raw || process.env.DATABASE_URL;
  const problem = checkUrl(url);
  if (problem) { console.error(problem); process.exit(1); }
  const pool = new Pool(Object.assign({
    connectionString: cleanUrl(url),
    ssl: sslFor(url),
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    keepAlive: true,
    application_name: 'travel-desk',
  }, opts || {}));
  // A hosted database drops idle connections now and then. Without this handler Node would stop the whole server.
  pool.on('error', (e) => console.error('Database connection dropped (the pool reconnects by itself): ' + e.message));
  return pool;
}

// "host:port/database" for log messages. Never includes the password.
function describe(raw) {
  const u = parseUrl(raw || process.env.DATABASE_URL || '');
  if (!u) return '(DATABASE_URL is not a valid address)';
  return u.hostname + (u.port ? ':' + u.port : '') + u.pathname;
}

// Turns a driver error into advice a person can act on.
function explain(e, raw) {
  const u = parseUrl(raw || process.env.DATABASE_URL || '');
  const host = u ? u.hostname : '';
  const msg = String((e && e.message) || e);
  const code = e && e.code;
  if (/password authentication failed/i.test(msg)) {
    return msg + '\nThe database password in DATABASE_URL is not right.'
      + (isSupabaseHost(host) ? ' In Supabase: Project Settings > Database > reset the password, then copy the connection string again.' : '');
  }
  if (/Tenant or user not found/i.test(msg)) {
    return msg + '\nWith the Supabase pooler the user must be postgres.<project-ref> (not just postgres). Copy the string from the Connect button in the Supabase dashboard.';
  }
  if (isSupabaseHost(host) && /^db\.[a-z0-9]+\.supabase\.co$/i.test(host) && (code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT')) {
    return msg + '\nThe direct Supabase address (db.<project>.supabase.co) works only over IPv6. Use the "Session pooler" connection string instead'
      + ' (host ends in pooler.supabase.com, port 5432). It works on every network.';
  }
  if (/self[- ]signed|unable to verify|certificate/i.test(msg)) {
    return msg + '\nThe database certificate was rejected. Remove DATABASE_SSL_CA from .env, or point it at the provider\'s CA file.';
  }
  if (!host || /(^|[ (])0\.\d+\.\d+\.\d+:/.test(msg)) {
    return msg + '\nThe address in DATABASE_URL looks wrong. A password with symbols such as @ : / # ? [ ] breaks it. Use a password of letters and numbers only.';
  }
  if (code === 'ECONNREFUSED') return msg + '\nNothing is listening at ' + describe(raw) + '. Check that PostgreSQL is running and the port is right.';
  return msg;
}

module.exports = { createPool, describe, explain, isSupabaseHost, cleanUrl, sslFor, checkUrl };
