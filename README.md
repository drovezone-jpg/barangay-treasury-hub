# Barangay Treasury Hub — Multi-Barangay Financial Management System

**Version 0.1.0 — Final build (Parts 1–6 complete: foundation, barangay management, collections/receipts/expenses, budgets/reports, tasks/audit/backup/settings, integration & packaging)**

A Windows desktop application (Electron + SQLite) for a single barangay treasurer who manages **2 to 5 barangays**. Runs fully offline; all data persists locally in SQLite.

> ⚠️ **DISCLAIMER — NOT OFFICIALLY COMPLIANT**
> This application produces management-information reports only. It is **not** certified as
> compliant with official Philippine government accounting rules (COA, DILG, BLGA, or others).
> Sample reports and sample data are demonstrations and MUST NOT be presented as official
> financial statements until independently validated by the appropriate authorities.

---

## Requirements

| Software | Version |
|---|---|
| Node.js | 18 LTS or newer (20+ recommended) |
| npm | 9+ (bundled with Node) |
| Windows | 10/11 x64 (for running and packaging the installer) |
| Build tools | Only if prebuilt binaries are unavailable: Visual Studio Build Tools + Python (better-sqlite3 ships prebuilds for common Electron/Node versions) |

## Development setup

```bash
npm install          # install dependencies
npm run rebuild      # compile better-sqlite3 against Electron's ABI (required before npm start)
npm start            # launch the desktop app in development mode
```

## Automated testing

```bash
npm test             # everything below, in order
npm run check              # node --check syntax scan of all JS files
npm run test:migrations    # schema migrations v1→v6 against a temp SQLite DB
npm run test:auth          # registration/login/persistence suite
npm run test:part2         # barangay management + dashboard suite
npm run test:part3         # collections/receipts/expenses/summaries suite
npm run test:part4         # budgets/utilization/reports suite
npm run test:part5         # tasks/audit/backup-restore/settings suite
npm run test:part6         # final integration & data-safety suite
```

All tests use temporary databases only — your real data is never touched.

## Windows installer build

Run on a Windows machine (cross-building the NSIS installer from Linux requires Wine, which is not available in all environments):

```bash
npm install
npm run rebuild        # compile native module against Electron ABI
npm run dist           # electron-builder → NSIS installer
```

**Expected output:** `dist\Barangay Treasury Hub Setup 0.1.0.exe` (x64, per-user install with optional directory, desktop and Start Menu shortcuts).

Packaging notes:
- `better-sqlite3` is unpacked from the asar archive (`asarUnpack`) so the native binding loads.
- `npmRebuild: true` recompiles the native module for Electron automatically during `dist`.
- **Installer build attempted on a headless Linux environment failed with:
  `wine is required, please see https://electron.build/multi-platform-build#linux`
  (`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` in `WinPackager.signApp`).** The configuration is
  complete and correct; generate the installer on Windows with the commands above.
- No code-signing certificate is configured, so Windows SmartScreen may warn on first run
  (choose "More info → Run anyway"). This is expected for unsigned local builds.

## Database storage

- Location: `%APPDATA%\barangay-treasury-hub\barangay-treasury-hub.db`
- The database is **never** stored in the installation directory; installing updates or reinstalling does not erase records.
- On a corrupt or incompatible database the app shows a clear error and exits **without modifying the file** — restore a backup over it, or move it aside manually to start fresh.
- Uninstalling the app does **not** delete application data (`deleteAppDataOnUninstall: false`).

## Backup and restore

**Backup:** Backup and Restore page → *Create backup…* → choose a location → a consistent `.sqlite` copy is written using SQLite's online backup API (safe while the app is in use). The app refuses to overwrite an existing backup file.

**Restore:** *Restore from backup file…* → confirm the warning → the file is validated (SQLite header, integrity check, required tables), a **safety backup** of current data is saved as `barangay-treasury-hub.db.pre-restore-<timestamp>.bak`, then the backup replaces the live database and the app reopens it. On any failure the original data is rolled back automatically.

> ⚠️ Restoring replaces **all** current records **and account credentials** with those in the backup. You will sign in again with the credentials stored in the backup.

Manual test procedure (recommended once before production use):
1. Install and launch the app; create the treasurer account.
2. Record one fictional collection and one expense.
3. Close and reopen the app — confirm both records persist.
4. Create a backup to a chosen folder.
5. Record another transaction, then restore the backup — confirm the second transaction is gone and the first two are back.

## First-run login

1. Launch the app (desktop shortcut: **Barangay Treasury Hub**).
2. First launch only: enter username (3–60 chars), display name, and a password of at least 8 characters → you are signed in directly.
3. Later launches: the form is a sign-in form. Wrong credentials show a generic "Invalid username or password." message.
4. Optional: *Load Sample Data* on the sidebar — every sample row is badged `SAMPLE` and excluded from all real totals and reports.

## Offline operation

Chart.js is bundled locally (`src/renderer/vendor/chart.umd.min.js`); there are no CDN scripts, remote fonts, cloud services, or network calls anywhere in the renderer. Login, dashboard, charts, reports, and all modules work with no internet connection.

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm start` fails with a better-sqlite3 ABI error | Run `npm run rebuild`, then `npm start` again |
| Installer build says "wine is required" | Build on Windows instead of Linux/macOS |
| SmartScreen warning on install | Expected for unsigned builds; More info → Run anyway |
| "Database error" dialog at launch | The DB file is corrupt or not a Treasury Hub database; restore a backup over it or move it aside (the app never deletes it) |
| Restore fails | Your data is rolled back automatically; the safety backup (`*.pre-restore-*.bak`) is kept next to the database |
| Forgot treasurer password | Restore a backup taken when the password was known, or move the DB file aside to start a fresh account (this orphans the old data — copy it first) |

## Protecting existing financial records

- Keep regular `.sqlite` backups outside the computer (USB drive, etc.).
- Never edit, rename, or delete files in `%APPDATA%\barangay-treasury-hub\` while the app is running.
- Do not copy the live `.db` file (with `-wal`/`-shm` sidecars) as a backup method — use the built-in backup feature.
- Test restores on this app only; restore replaces everything.

## Known issues and limitations

- The installer could not be generated in the headless Linux development environment (missing Wine); it must be built on Windows (`npm run rebuild && npm run dist`).
- No code signing; SmartScreen will warn on first install.
- Graphical dialogs (backup save/restore) and printing were verified at the logic level and via the print stylesheet, but not exercised in a rendered Windows GUI session — perform the manual test procedure above once.
- Restore replaces all data including the treasurer account; there is no per-record selective restore.
- Backup reminders are stored but only informational (no popup scheduler).
- Audit entries created before user attribution existed show "not recorded (legacy entry)".
- Receipt printing/PDF export is prepared but not yet implemented (receipts are recorded data only).
- No per-report pagination in the on-screen report view (CSV export handles large datasets).

## Project structure

```
barangay-treasury-hub/
├── package.json               # scripts, deps, electron-builder NSIS config
├── README.md
├── src/
│   ├── main/                  # main process (owns SQLite, dialogs, dialogs only)
│   │   ├── main.js            # lifecycle + whitelisted IPC handlers
│   │   ├── database.js        # data layer: prepared statements + validation
│   │   ├── migrations.js      # versioned migrations (v1→v6)
│   │   ├── auth.js            # treasurer registration/login
│   │   ├── security.js        # scrypt password hashing
│   │   ├── backup-restore.js  # online backup API + validated restore with rollback
│   │   └── seed-data.js       # clearly-labeled sample data loader
│   ├── preload/preload.js     # contextBridge: fixed channel→method whitelist
│   └── renderer/              # HTML/CSS/vanilla JS UI (no CDNs)
└── tests/                     # 8 headless suites (part1-part6, auth, migrations)
```

## Security architecture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Renderer talks to the DB only through `window.treasuryAPI` — a fixed whitelist of IPC channels
- All SQL uses prepared statements in the main process; no SQL crosses IPC
- Passwords: scrypt with per-user random salt, `timingSafeEqual` comparison, no plaintext anywhere
- Filesystem access (backup/restore dialogs) only via controlled main-process handlers
- Audit trail strips password/hash/salt fields from details and never stores credentials

## Building the Windows installer with GitHub Actions (recommended)

The repository includes `.github/workflows/build-windows.yml`, which builds the
installer on a real Windows runner:

1. Create a GitHub repository and push this project to it (do not commit `node_modules` or `dist`).
2. Open the repository → **Actions** tab → select **Build Windows Installer** → **Run workflow**.
3. When the run finishes (green check), open it → **Artifacts** → download **Barangay-Treasury-Hub-Setup**.
4. Unzip it: inside is `Barangay-Treasury-Hub-Setup.exe`, ready to install.

Notes: the workflow runs the full test suite first, then rebuilds better-sqlite3
against Electron, then builds the NSIS installer. If tests fail, no installer is produced.
