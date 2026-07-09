# Event Attendance Check-In

A mobile-friendly React app for checking attendees into events by scanning Cvent badge QR codes. Staff sign in with Supabase Auth, upload an attendee Excel file, scan badges at the door, prevent duplicate check-ins, and export updated attendance data.

## Project Structure

```text
.
├── public/
│   └── manifest.webmanifest
├── src/
│   ├── App.css
│   ├── App.tsx
│   ├── excel.ts
│   ├── index.css
│   ├── main.tsx
│   ├── storage.ts
│   ├── supabase.ts
│   └── types.ts
├── supabase/
│   └── schema.sql
├── .env.example
├── index.html
├── package.json
└── vite.config.ts
```

## Supabase Setup

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. Open the Supabase SQL Editor.
3. Run the full SQL script in `supabase/schema.sql`.
4. Go to Authentication settings and disable public signup if you only want manually created staff accounts.
5. Create staff users in Supabase Authentication.

The schema enables Row Level Security. Only authenticated Supabase users can read attendees, upload/import attendees, update check-ins, clear data, or change the event name.

## Local Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Fill in these values from Supabase Project Settings > API:

```bash
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

Use the anon key only. Do not put the Supabase service role key in this frontend app or in Vercel client environment variables.

## Install and Run

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Sign in with a Supabase staff account before using the scanner or admin page.

## Build

```bash
npm run build
npm run preview
```

## Deploy to Vercel

1. Push this repository to GitHub.
2. Go to [vercel.com](https://vercel.com) and import the GitHub repository.
3. Use these build settings:
   - Framework Preset: `Vite`
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. Add these Vercel environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Deploy.

Vercel provides HTTPS automatically, which is required for mobile camera access outside `localhost`.

## Add to Mobile Device

Open the Vercel URL on the phone:

- iPhone Safari: Share button > Add to Home Screen
- Android Chrome: menu > Add to Home screen or Install app

The app includes a web manifest so it can launch like a mobile web app.

## Excel Import Format

Upload `.xlsx`, `.xls`, or `.csv` files from the Admin page. The first sheet is imported. The app detects common Cvent-style headers, including:

- Attendee name: `Attendee Name`, `Full Name`, `Name`, or `First Name` plus `Last Name`
- Email or ID: `Email`, `Email Address`, `Attendee ID`, `Registration ID`, `Confirmation Number`
- QR code: `QR Code`, `QR Code Value`, `Cvent QR Code`, `Badge Code`, `Barcode`, `Code`
- Optional fields: `Company`, `Organization`, `Ticket Type`, `Registration Type`, `Attendee Type`

Rows without a QR code are skipped. Duplicate QR code values are skipped with an import warning. Uploading a new file replaces the current shared attendee list.

## How It Works

1. Staff sign in with Supabase email/password.
2. Admin uploads the attendee export.
3. Staff open the Check-In page and tap Start Camera.
4. The scanner reads the Cvent badge QR code.
5. If the code matches, Supabase stores `checked_in`, `check_in_time`, and the staff user ID.
6. If the attendee is scanned again, the app shows an already checked-in warning.
7. Admin exports CSV or Excel after the event.

## Security Notes

- All app data is stored in Supabase, not browser `localStorage`.
- Row Level Security allows database access only for authenticated staff.
- The frontend uses the Supabase anon key with RLS policies.
- Keep the service role key private and server-only.
- Disable public signup for stricter event staff control.
- Use HTTPS hosting through Vercel for mobile camera support.

## Dependencies

- React and Vite for the mobile web app
- Supabase Auth and Postgres for staff login and shared storage
- `@zxing/browser` for phone-camera QR scanning
- `xlsx` SheetJS for Excel and CSV import/export
