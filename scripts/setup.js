'use strict';
// One-step setup: creates the PostgreSQL user and database, writes .env, creates the tables and
// (optionally) loads the example employees. Run it with:  npm run setup
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { Pool } = require('pg');
const { setDefaultPasswords, DEFAULT_PASSWORD } = require('../lib/auth');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = process.env.SETUP_ENV_FILE || path.join(ROOT, '.env');
const NAME_RE = /^[a-z_][a-z0-9_]{0,40}$/;

function ask(question, def, envKey) {
  if (envKey && process.env[envKey] !== undefined) return Promise.resolve(process.env[envKey]);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + (def !== undefined && def !== '' ? ' [' + def + ']' : '') + ': ', (a) => {
      rl.close();
      resolve(a.trim() === '' && def !== undefined ? def : a.trim());
    });
  });
}

function askHidden(question, envKey) {
  if (envKey && process.env[envKey] !== undefined) return Promise.resolve(process.env[envKey]);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question + ': ');
    let buf = '';
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          if (stdin.setRawMode) stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          stdin.pause();
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (c === '\u0003') process.exit(1);
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

const url = (user, pass, host, port, db) =>
  `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;

function randomPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(14), (b) => chars[b % chars.length]).join('');
}

(async () => {
  console.log('\nTravel Desk setup\n-----------------');
  console.log('This creates a PostgreSQL user and database for Travel Desk, then the tables.');
  console.log('You need the password of your PostgreSQL administrator user (usually "postgres").\n');

  const host = await ask('PostgreSQL address', 'localhost', 'SETUP_HOST');
  const port = await ask('PostgreSQL port', '5432', 'SETUP_PORT');
  const adminUser = await ask('Administrator user', 'postgres', 'SETUP_ADMIN_USER');
  const adminPass = await askHidden('Administrator password (typing is hidden)', 'SETUP_ADMIN_PASSWORD');
  const appUser = await ask('Name for the Travel Desk database user', 'traveldesk', 'SETUP_APP_USER');
  const dbName = await ask('Name for the Travel Desk database', 'travel_desk', 'SETUP_DB');
  let appPass = await ask('Password for that user (press Enter to generate one)', '', 'SETUP_APP_PASSWORD');

  if (!NAME_RE.test(appUser) || !NAME_RE.test(dbName)) {
    console.error('\nUse only lowercase letters, numbers and underscores for the user and database names.');
    process.exit(1);
  }
  if (!appPass) appPass = randomPassword();
  if (!/^[A-Za-z0-9]{6,60}$/.test(appPass)) {
    console.error('\nUse only letters and numbers, at least 6 of them, for the database password.');
    process.exit(1);
  }

  // 1. Create the user and database as the administrator.
  const admin = new Pool({ connectionString: url(adminUser, adminPass, host, port, 'postgres') });
  try {
    const role = await admin.query(`SELECT 1 AS found FROM pg_roles WHERE rolname = $1`, [appUser]);
    if (role.rows.length) {
      await admin.query(`ALTER ROLE ${appUser} WITH LOGIN PASSWORD '${appPass}'`);
      console.log(`\nUser "${appUser}" already existed. Its password was updated.`);
    } else {
      await admin.query(`CREATE ROLE ${appUser} WITH LOGIN PASSWORD '${appPass}'`);
      console.log(`\nCreated user "${appUser}".`);
    }
    const db = await admin.query(`SELECT 1 AS found FROM pg_database WHERE datname = $1`, [dbName]);
    if (db.rows.length) {
      console.log(`Database "${dbName}" already exists. It will be used as it is.`);
    } else {
      await admin.query(`CREATE DATABASE ${dbName} OWNER ${appUser}`);
      console.log(`Created database "${dbName}".`);
    }
  } catch (e) {
    console.error('\nCould not create the user and database: ' + e.message);
    if (/password authentication/i.test(e.message)) console.error('The administrator user or password is not correct. Try again.');
    else if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Connection refused/i.test(e.message)) console.error('PostgreSQL is not reachable at ' + host + ':' + port + '. Check that it is running and the port is right.');
    process.exit(1);
  } finally {
    await admin.end();
  }

  // 2. Save the settings.
  const dbUrl = url(appUser, appPass, host, port, dbName);
  if (fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(ENV_FILE, ENV_FILE + '.old');
    console.log('Your earlier settings file was kept as ' + path.basename(ENV_FILE) + '.old');
  }
  fs.writeFileSync(ENV_FILE, `DATABASE_URL=${dbUrl}\nPORT=3000\nCOOKIE_SECURE=false\nALLOW_RESET=false\n`);
  console.log('Saved the settings to ' + path.basename(ENV_FILE) + '.');

  // 3. Create the tables, and load the example data on a new database.
  const app = new Pool({ connectionString: dbUrl });
  try {
    await app.query(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
    console.log('Created the tables.');
    const count = await app.query(`SELECT count(*) AS n FROM users`);
    const hasUsers = Number(count.rows[0].n) > 0;
    let seed = !hasUsers;
    if (hasUsers) {
      const a = await ask('The database already has employees. Replace everything with the example data? (yes/no)', 'no', 'SETUP_RESEED');
      seed = /^y/i.test(a);
    } else {
      const a = await ask('Load the example employees, policy and claims? (yes/no)', 'yes', 'SETUP_SEED');
      seed = /^y/i.test(a);
    }
    if (seed) {
      await app.query(fs.readFileSync(path.join(ROOT, 'db', 'seed.sql'), 'utf8'));
      await setDefaultPasswords((t, p) => app.query(t, p));
      console.log('Loaded the example data.');
      console.log(`\nSign in with employee code 0011 (employee), 0014 (HOD) or 0015 (finance).`);
      console.log(`The temporary password is ${DEFAULT_PASSWORD}. You choose your own at first sign-in.`);
    } else if (!hasUsers) {
      console.log('\nThe tables are empty. Add your employees to the "users" table, then give each a password with:');
      console.log('  npm run user:password -- <employee code> <temporary password>');
    }
    console.log('\nSetup finished. Start the app with:  npm start   and open http://localhost:3000\n');
  } catch (e) {
    console.error('\nThe tables could not be created: ' + e.message);
    process.exit(1);
  } finally {
    await app.end();
  }
})();
