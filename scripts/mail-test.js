'use strict';
// Sends one test e-mail with the settings in .env:   npm run mail:test -- you@company.com
require('../lib/env');
const mail = require('../lib/mail');
const to = process.argv[2];
if (!to) { console.error('Usage: npm run mail:test -- you@company.com'); process.exit(1); }
if (!mail.configured()) { console.error('Mail is not set up. Add SMTP_HOST and MAIL_FROM (and SMTP_USER / SMTP_PASS) to the .env file.'); process.exit(1); }
mail.send({ to, subject: 'Travel Desk test e-mail', text: 'This is a test e-mail from Travel Desk. Your mail settings work.' })
  .then(() => console.log('Test e-mail sent to ' + to + '.'))
  .catch((e) => { console.error('Could not send: ' + e.message); process.exit(1); });
