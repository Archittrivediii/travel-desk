'use strict';
// Minimal SMTP client (no extra packages). Settings come from .env:
//   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for port 465), SMTP_USER, SMTP_PASS, MAIL_FROM
// On port 587 the connection is upgraded with STARTTLS automatically.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');

const cfg = () => ({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || ''),
  starttls: !/^(0|false|no)$/i.test(process.env.SMTP_STARTTLS || 'true'),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
});
const configured = () => { const c = cfg(); return !!(c.host && c.from); };

const addr = (s) => { const m = String(s).match(/<([^>]+)>/); return (m ? m[1] : String(s)).trim(); };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=');

function buildMessage(c, { to, subject, text }) {
  const body = b64(text).replace(/(.{76})/g, '$1\r\n');
  return [
    'From: ' + c.from,
    'To: ' + to,
    'Subject: ' + encHeader(subject.replace(/[\r\n]+/g, ' ')),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@' + (os.hostname() || 'traveldesk') + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '', body, '',
  ].join('\r\n');
}

function send(msg) {
  const c = cfg();
  if (!configured()) return Promise.resolve({ skipped: true });
  return new Promise((resolve, reject) => {
    let sock, buf = '', waiting = null, done = false;
    const fail = (e) => { if (done) return; done = true; try { sock && sock.destroy(); } catch (x) { /* ignore */ } reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('The mail server did not answer in time.')), 30000);
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch (x) { /* ignore */ } resolve(v); };

    const onData = (d) => { buf += d.toString('utf8'); pump(); };
    const pump = () => {
      if (!waiting) return;
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          const text = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiting; waiting = null;
          return w({ code: Number(text[i].slice(0, 3)), text });
        }
      }
    };
    const reply = () => new Promise((res) => { waiting = res; pump(); });
    const cmd = async (line, ok) => {
      if (line) sock.write(line + '\r\n');
      const r = await reply();
      if (!ok.includes(r.code)) throw new Error('Mail server said: ' + r.text[r.text.length - 1]);
      return r;
    };
    const attach = (s) => { sock = s; s.on('data', onData); s.on('error', fail); s.on('close', () => { if (!done) fail(new Error('The mail server closed the connection.')); }); };

    (async () => {
      attach(c.secure ? tls.connect({ host: c.host, port: c.port, servername: c.host }) : net.connect({ host: c.host, port: c.port }));
      await cmd(null, [220]);
      const me = os.hostname() || 'localhost';
      let r = await cmd('EHLO ' + me, [250]);
      if (!c.secure && c.starttls && r.text.some((l) => /STARTTLS/i.test(l))) {
        await cmd('STARTTLS', [220]);
        sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error');
        buf = '';
        attach(tls.connect({ socket: sock, servername: c.host }));
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        r = await cmd('EHLO ' + me, [250]);
      }
      if (c.user) {
        const adv = r.text.join(' ').toUpperCase();
        if (adv.includes('AUTH') && !/\bPLAIN\b/.test(adv) && /\bLOGIN\b/.test(adv)) {   // e.g. Microsoft 365
          await cmd('AUTH LOGIN', [334]);
          await cmd(b64(c.user), [334]);
          await cmd(b64(c.pass), [235]);
        } else {
          await cmd('AUTH PLAIN ' + b64('\0' + c.user + '\0' + c.pass), [235]);
        }
      }
      await cmd('MAIL FROM:<' + addr(c.from) + '>', [250]);
      await cmd('RCPT TO:<' + addr(msg.to) + '>', [250, 251]);
      await cmd('DATA', [354]);
      const data = buildMessage(c, msg).replace(/\r\n\./g, '\r\n..');
      await cmd(data + '\r\n.', [250]);
      try { sock.write('QUIT\r\n'); } catch (x) { /* ignore */ }
      finish({ sent: true });
    })().catch(fail);
  });
}

module.exports = { send, configured };
