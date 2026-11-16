# Travel Desk

Travel requests, HOD approvals and expense claims, stored in PostgreSQL.

## What you need
- PostgreSQL 12 or newer (already installed on your machine)
- Node.js 18 or newer (https://nodejs.org)

## Set up
**Windows, easiest:** double-click `setup-windows.bat`. It installs the package, asks for your PostgreSQL administrator password (usually the `postgres` user), creates the Travel Desk user and database for you, writes the settings file, creates the tables, loads the example employees, and opens the app at http://localhost:3000. Keep the window open while you use the app. Next time, double-click `start-windows.bat`.

**Any system, from a terminal in this folder:**

```
npm install
npm run setup
npm start
```

`npm run setup` asks the same questions. Then open http://localhost:3000

**By hand:** create a database and user yourself, copy `.env.example` to `.env`, set `DATABASE_URL`, then run `npm run db:init` and `npm run db:seed`. `db:seed` replaces everything in the Travel Desk tables, so use it only on a new database.

## Using Supabase

Travel Desk works with a Supabase database. It needs nothing from Supabase except the PostgreSQL connection.

1. In the Supabase dashboard press **Connect** and copy the **Session pooler** connection string. (The "Direct connection" address works only over IPv6, so on most home and office networks it fails. The pooler works everywhere.)
2. Put your database password where it says `[YOUR-PASSWORD]`, **including the square brackets**. Use a password of letters and numbers only, because symbols such as `@ : / # ? [ ]` break the address. You can reset it under Project Settings > Database.
3. Set it as `DATABASE_URL` in `.env`, or run `npm run setup` and choose option 2.
4. Run `npm run db:init` (or just `npm start`: the tables are created and updated on every start), then `npm run db:seed` for example data or `npm run user:add` for real people.

The app turns on SSL for Supabase by itself. The connection is encrypted; the certificate is accepted without checking the issuer, because Supabase signs with its own authority. For full checking download Supabase's certificate (Project Settings > Database > SSL Configuration) and set `DATABASE_SSL_CA` to its path.

**Security.** Supabase publishes the tables of the `public` schema through its web API to anyone who holds the project's public key. Travel Desk does not use that API, so every start it switches row level security on for all of its tables and removes the API roles' rights. The Supabase security advisor then shows "RLS enabled, no policy" notes for each table. That is intended: it means the web API is locked out while the app, which connects directly, keeps working. If you add a table to `db/schema.sql`, add its name to the list at the bottom of that file.

**Free plan.** Supabase pauses a free project after a week without activity; the first sign-in after that waits while it wakes up. If you see "too many clients", lower `DATABASE_POOL_MAX`.

## Where the data lives
| Table | Holds |
|-------|-------|
| `users` | Employees: code, name, role (`employee`, `manager` = HOD, `admin` = finance), grade, department, designation, password hash |
| `sessions` | Who is signed in right now |
| `policy` | Flight class, hotel cap and daily allowance for each grade |
| `budgets` | Quarterly budget for each department |
| `trips` | Trip requests and their approval status |
| `expenses` | Every row of an expense claim. Status moves Draft, Pending HOD, Approved, Reimbursed (or Rejected) |

The schema is in `db/schema.sql`. Add your real employees with normal `INSERT INTO users ...` statements, or edit `db/seed.sql` before running `npm run db:seed`.
Each department needs at least one user with role `manager`. That person is the HOD who receives the claims.

## Approval rules the server enforces
- An HOD approves expense claims from their own department. Finance approves claims filed by HODs.
- Nobody approves their own request or claim.
- Trip requests inside a grade's limits need only the HOD. Requests above the limits also go to finance.
- Only finance marks approved expenses as reimbursed and edits the policy.

## Signing in
People sign in with their **employee code** (the `code` column in `users`) and a password.

- After `npm run db:seed`, every example user has the temporary password `Welcome@123` and must choose their own at first sign-in. Example codes: `0011` Priya (employee), `0014` Rahul (HOD, Sales), `0015` Anita (finance).
- Passwords are stored only as scrypt hashes. Sessions last 12 hours and use an HttpOnly cookie. Five wrong attempts in a row lock that code out for 15 minutes.
- Anyone signed in can use **Change password** at the top of the page. Changing it signs out that person's other devices.
- To set or reset a password for a real employee (they must change it at next sign-in):

  ```
  npm run user:password -- 0021 TempPass#2026
  ```

  Add `--keep` to let them keep that password.
- When you add real employees with `INSERT INTO users ...`, give them a password with the command above. Until then they cannot sign in.

## Putting it on the internet

Travel Desk is an ordinary Node.js program, so any host that runs Node works (Render, Railway, Fly.io, or your company's own server). The data stays in your Supabase database. Example with Render:

1. Push the project to GitHub. The `.env` file is never uploaded (it is in `.gitignore`), so your password stays private.
2. In Render choose **New > Web Service**, connect the GitHub repository and the `main` branch.
3. Settings: Language **Node**, Build Command `npm install`, Start Command `npm start`, Health Check Path `/api/health`. Pick the region closest to your Supabase project, because the app talks to the database on every click. A free instance goes to sleep when nobody uses it and the first visit afterwards is slow, so use a paid instance if people should never wait.
4. Add these environment variables (Render supplies `PORT` itself, so do not set it):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | the Supabase **Session pooler** string, with your real password |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `1` |
| `ALLOW_RESET` | `false` |
| `APP_URL` | the address Render gives you, for example `https://travel-desk.onrender.com` (used in the e-mails) |

5. Press **Create Web Service**. When it is live, open the address and sign in. Every push to `main` deploys again by itself. Look at the first lines of the log: the app prints a `WARNING` if a setting is unsafe for a live site.

**Never run `npm run db:seed` against the live database.** It replaces everything with the example data. Add real people from your own computer with `npm run user:add` (your `.env` points at the same Supabase database), or from the same command on the host's shell.

`TRUST_PROXY=1` tells the app that one proxy (the host's) sits in front of it. Without it the limit on wrong passwords treats every visitor as one person, so a stranger could lock a colleague out with a few wrong tries. Set it only when the app really runs behind such a proxy. Some hosts block outgoing e-mail on their free plans; if notifications do not arrive, check the host's rules or use a paid plan.

## Before real use
- Serve the app over HTTPS (for example behind your company web server or reverse proxy) and set `COOKIE_SECURE=true` in `.env`, so the sign-in cookie never travels unencrypted.
- Leave `ALLOW_RESET=false` on the real system. When it is `true`, a finance user can open `/?reset` and wipe all data back to the examples.
- Back up the `travel_desk` database as you do your other company databases.
- If your company uses single sign-on (Microsoft, Google), the sign-in step in `server.js` (`/api/login` and `getSession`) is the part to replace.

## E-mail notifications

Travel Desk e-mails the requester and the next approver when a request is submitted, approved or rejected.
Add your mail server to the `.env` file (see `.env.example`):

    SMTP_HOST=smtp.your-company.com
    SMTP_PORT=587
    SMTP_SECURE=false
    SMTP_USER=it@your-company.com
    SMTP_PASS=the-mail-password
    MAIL_FROM=Travel Desk <it@your-company.com>
    APP_URL=http://localhost:3000

Port 587 uses STARTTLS automatically; for port 465 set `SMTP_SECURE=true`. Restart the server after editing `.env`.
Check the settings with `npm run mail:test -- you@your-company.com`.
Every message is also listed in the `mail_outbox` table with its status (Sent, Failed with the reason, or Not configured).

