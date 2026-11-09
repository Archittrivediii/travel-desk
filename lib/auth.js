'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const DEFAULT_PASSWORD = 'Welcome@123';

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}

// Always does the same work, even when the user does not exist, so timing does not reveal valid employee codes.
async function verifyPassword(password, stored) {
  const parts = (stored || '').split('$');
  const valid = parts.length === 3 && parts[0] === 'scrypt';
  const salt = valid ? Buffer.from(parts[1], 'hex') : crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  if (!valid) return false;
  const expected = Buffer.from(parts[2], 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

function passwordProblem(password, current) {
  if (typeof password !== 'string' || password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 100) return 'Use 100 characters or fewer.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Include at least one letter and one number.';
  if (password === current) return 'Choose a password different from your current one.';
  return '';
}

// Gives every user who has no password yet the default one, and makes them change it at first sign-in.
async function setDefaultPasswords(query) {
  const r = await query(`SELECT id FROM users WHERE password_hash IS NULL`);
  for (const u of r.rows) {
    await query(`UPDATE users SET password_hash = $2, must_change = true WHERE id = $1`, [u.id, await hashPassword(DEFAULT_PASSWORD)]);
  }
  return r.rows.length;
}

module.exports = { DEFAULT_PASSWORD, hashPassword, verifyPassword, passwordProblem, setDefaultPasswords };
