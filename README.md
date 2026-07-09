# Event Attendance Check-In

A mobile-friendly React app for checking attendees into events by scanning Cvent badge QR codes. Staff can upload an attendee Excel file before the event, scan badges at the door, prevent duplicate check-ins, and export an updated file with status and check-in time.

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
│   └── types.ts
├── index.html
├── package.json
└── vite.config.ts
```

## Install

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. For camera testing on a phone, use one of these options:

- Run on `localhost` directly on the same device.
- Serve the app over HTTPS.
- Use a secure tunnel such as Cloudflare Tunnel, ngrok, or a deployed HTTPS host.

Mobile browsers block camera access on plain HTTP except for `localhost`.

## Build

```bash
npm run build
npm run preview
```

## Excel Import Format

Upload `.xlsx`, `.xls`, or `.csv` files from the Admin page. The first sheet is imported. The app detects common Cvent-style headers, including:

- Attendee name: `Attendee Name`, `Full Name`, `Name`, or `First Name` plus `Last Name`
- Email or ID: `Email`, `Email Address`, `Attendee ID`, `Registration ID`, `Confirmation Number`
- QR code: `QR Code`, `QR Code Value`, `Cvent QR Code`, `Badge Code`, `Barcode`, `Code`
- Optional fields: `Company`, `Organization`, `Ticket Type`, `Registration Type`, `Attendee Type`

Rows without a QR code are skipped. Duplicate QR code values are skipped with an import warning.

## How It Works

1. Go to Admin and upload the attendee export.
2. Go to Check-In and tap Start Camera.
3. Scan the Cvent badge QR code.
4. If the QR code matches the uploaded data, the app marks the attendee as Checked In and saves the timestamp.
5. If the attendee is scanned again, the app shows an already checked-in warning.
6. Export CSV or Excel from Admin after the event.

Data is stored locally in the browser with `localStorage`, so it persists after refreshes on the same device. For multiple entrance devices sharing one live attendee list, replace `src/storage.ts` with a backend database API.

## Dependencies

- React and Vite for the mobile web app
- `@zxing/browser` for phone-camera QR scanning
- `xlsx` SheetJS for Excel and CSV import/export
# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
