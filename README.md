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

