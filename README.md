# Event Attendance Check-In

A mobile-friendly event check-in app with server-side QR verification. Staff sign in with a PostgreSQL `public.users` account, scan badge QR codes from a phone browser, and the Node/Express backend marks attendees as checked in with duplicate prevention.

## Project Structure

```text
.
├── postgres/
│   └── schema.sql
├── public/
│   ├── manifest.webmanifest
│   ├── favicon.svg
│   └── nct.png
├── server/
│   └── index.js
├── src/
│   ├── App.css
│   ├── App.tsx
│   ├── excel.ts
│   ├── main.tsx
│   ├── storage.ts
│   └── types.ts
├── .env.example
├── index.html
├── package.json
└── vite.config.ts
```

## PostgreSQL Setup In pgAdmin

Run `postgres/schema.sql` in the target database. The app expects these main tables:

- `public.users`: staff login accounts with `email`, `password_hash`, `role`, and optional `client_id`.
- `public.attendees`: attendee data and check-in status.
- `public.scan_attempts`: audit/rate-limit log with hashed QR values.
- `public.app_settings`: event name.

Use `role = 'admin'` for users who can view/export/clear attendees and edit the event name. Other roles are treated as scanner-only users.

Minimum attendee columns are `id`, `name`, and `qr_code`. The database trigger fills `qr_code_normalized` automatically from `qr_code`.

## Environment Variables

Copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

Fill in:

```env
DATABASE_URL=postgres://user:password@host:5432/database
JWT_SECRET=replace-with-a-random-string-at-least-32-characters
SCAN_RATE_LIMIT_PER_MINUTE=60
LOGIN_RATE_LIMIT_PER_15_MINUTES=10
MAX_IMPORT_ATTENDEES=5000
POSTGRES_SSL=true
COOKIE_SECURE=true
PORT=3001
BASE_PATH=/corporate/QrCode
VITE_BASE_PATH=/corporate/QrCode/
```

Set `POSTGRES_SSL=false` if PostgreSQL is on the same Linux server and does not use SSL.
Set `COOKIE_SECURE=true` when serving the app over HTTPS in production.

Do not put secrets in `public/`. Anything inside `public/` is served on the live website.

## Local Development

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173/corporate/QrCode/
```

`http://localhost:5173/QrCode/` serves the same app during local development.

Health check:

```text
http://localhost:5173/corporate/QrCode/api/health
```

`npm run dev` starts both the Express API and the Vite frontend. Vite reads `PORT` from `.env` and proxies `/corporate/QrCode/api/*` and `/QrCode/api/*` to Express. Express must be listening on that port.
The database health endpoint `/corporate/QrCode/api/health/db` is protected and requires an admin session.

## Production Run

```bash
npm run build
npm start
```

Open:

```text
http://localhost:3001/corporate/QrCode/
```

## Linux Deployment

The login page stays at `https://www.newconcepttravel.com/corporate/QrCode/`. That host only has the static files. The API stays at `https://qrcode.newconcepttravel.com/corporate/QrCode/`, which is the Nginx site that proxies to Express on port 3061.

A production build calls `https://qrcode.newconcepttravel.com/corporate/QrCode/api/...`. Express allows the browser on `https://www.newconcepttravel.com` to send the session cookie.

On the API server:

```bash
cd /home/nct/QRCODE
npm install
npm run build
pm2 restart qr-code-checkin
curl -i https://qrcode.newconcepttravel.com/corporate/QrCode/api/health
```

Copy the new `dist/` folder to the document root that serves `https://www.newconcepttravel.com/corporate/QrCode/`. Leave the existing `qrcode.newconcepttravel.com` Nginx location as it is.

The health check must return `{"ok":true}` with `X-Powered-By: Express`. In the browser, login must request `https://qrcode.newconcepttravel.com/corporate/QrCode/api/login`, not `https://www.newconcepttravel.com/corporate/QrCode/api/login`.

Use HTTPS for the live URL. Phone camera access requires HTTPS outside `localhost`.

## How It Works

1. Staff sign in with email/password.
2. The backend checks `public.users.password_hash` with bcrypt.
3. A signed HTTP-only session cookie is created.
4. Scanner devices call `/corporate/QrCode/api/verify-scan` with only the scanned QR value.
5. The backend rate-limits the staff user, hashes the scanned QR for audit logging, checks PostgreSQL, and atomically marks the attendee checked in.
6. The browser receives only minimal data: status, attendee name, and check-in time.
7. Duplicate scans are rejected server-side.
8. Admin users can view/search/export attendees.

## Dependencies

- React and Vite for the mobile web app
- Node.js and Express for the Linux backend
- PostgreSQL managed with pgAdmin
- `pg` for database access
- `bcryptjs` for password verification
- `jose` for signed sessions
- `@zxing/browser` for phone-camera QR scanning
- `xlsx` SheetJS for Excel export
