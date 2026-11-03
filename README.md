# Coaching Hub

A personal coaching tool for one coach (Jack). It runs on your Mac and opens in your browser. There are no accounts, no hosting and no subscriptions, and it works offline.

## Start it

**Easiest: the Mac app.** Download `Coaching-Hub-Mac-App.zip`, double-click it, and drag **Coaching Hub** into Applications. Then drag it from Applications onto your Dock. Nothing else needs installing, because the app carries its own copy of Node.js.

The first time you open it, macOS may say it can't check the app for malware, because it isn't from the App Store. Click **Done**, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Coaching Hub. You only do this once per Mac.

The app starts a small background server (a login item called Coaching Hub, so calendar sync and daily backups keep running) and opens Coaching Hub in Chrome. The first time, it offers to **install Coaching Hub as an app**: one click gives it its own window and its own Dock icon. Keep that icon in the Dock and use it from then on. To stop the background server, use **Settings → Quit Coaching Hub**. Opening the app from Applications starts it again.

**Without the app:** install Node.js 22.13 or newer from [nodejs.org](https://nodejs.org/en/download), then double-click **`Coaching Hub.command`** in this folder. Keep the Terminal window open while you work.

To build the app yourself: `mac/build-app.sh` (it downloads and checks Node.js, then writes `dist/Coaching Hub.app`).

### Optional: keep it running in the background

```bash
cd ~/Applications/coaching-hub
./scripts/install-login-item.sh     # start at login, no Terminal window
./scripts/uninstall-login-item.sh   # undo
```

This step is only needed if you want the calendar subscription to stay fresh and the daily backups to run without opening the app.

## Where your data lives

| What | Where |
|---|---|
| Database (SQLite) | `~/Library/Application Support/CoachingHub/coaching-hub.sqlite` |
| Attached files and photos | `~/Library/Application Support/CoachingHub/attachments/` |
| Backups | `~/Library/Application Support/CoachingHub/backups/` |

Nothing is stored only in the browser. You can delete and reinstall the app folder without losing data.

### Using it on two Macs (iCloud Drive)

In **Settings → Use on more than one Mac**, click **Move my data to iCloud Drive** on the first Mac. On the second Mac, install the app, then click **Use the data from iCloud Drive**. Both Macs now share one set of athletes, stored in `iCloud Drive/Coaching Hub`.

Use it on one Mac at a time. While a Mac is using the data it marks it as in use. If you open the app on the other Mac, you'll see "Coaching Hub is open on …" with **Try again** and **Open here anyway**. A Mac lets go of the data by itself 15 minutes after you last used it, so leaving the app running doesn't lock you out. A Mac that crashed stops counting after 3 minutes. Before switching, the app always saves a backup.

## Automatic updates and imports

- **App updates:** the Mac app checks `jacksteadd-code/coaching-hub-local` (main branch) every few hours. When `package.json` there has a higher version, it downloads the branch, checks it, swaps in the new `server/` and `public/` inside the app, and restarts. Your data, backups and the bundled Node.js are not touched. This needs the repository to be public. Turn it off or check now in **Settings → App updates**.
- **Import folder:** save TrainingPeaks workout exports (.zip or .csv) into `Coaching Hub Imports` in your home folder (not Documents: macOS blocks background apps from Documents, Desktop and Downloads), with the athlete's name in the file name. Small spelling differences are fine (one letter for names of 5+ letters, two for 9+). They're imported within a minute, then moved to `Imported`. Files that can't be matched go to `Needs attention`. Settings → Automatic import has the folder button and a log.

## Backup and restore

- **Settings → Download backup now** creates one `.chbackup` file. It contains the whole database and every attached file.
- **Automatic daily backups** run while the app is running. The last 14 are kept. In Settings you can name a second folder for copies, such as iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/Coaching Hub Backups`), so a copy also lives off this Mac.
- **Settings → Restore from backup…** replaces everything with the chosen backup. Before it does, it saves a safety backup of your current data (`coaching-hub-before-restore-…`).
- **Export:** Settings gives you all data as JSON and all sessions as CSV, for use in other tools.

## The workflow it supports

1. **Add athlete:** use Athletes → Add athlete.
2. **Record background and goals:** on the Profile tab, fill in personal, coaching, availability by weekday, facilities, and health and wellbeing (optional, marked as sensitive). Set the review and testing rhythm here too.
3. **Add races and test results:** use the Races and Tests tabs. Each test records its protocol, raw result, derived value with the calculation method, conditions and source, and whether you accept it for zones from an effective date. Older sessions keep the thresholds that applied at the time.
4. **Enter or import weekly training:** on the Training tab, log the week or use Import CSV (TrainingPeaks workouts export, or any CSV with column mapping). You get a preview, validation and duplicate detection, and re-importing a file is safe. Undo removes the sessions an import added.
5. **Review trends:** the Training tab shows 4, 8, 12 or 26 weeks of planned vs completed hours by sport, compares each week with your own baseline, and lists loads separately by method.
6. **Plan upcoming weeks:** the Season Planner has a season strip and a weekly detail grid. Edits stay a draft until you review the differences and apply them. Every change saves a version you can restore. **Suggest weekly hours** builds an explainable suggestion that you approve, edit or reject.
7. **Create follow-up reminders:** add tasks from any attention flag or from Notes & tasks. Calls, tests and reviews can go to your calendar.

The **Overview** shows who needs attention and why, your tasks this week, upcoming races, birthdays, and last week's planned vs completed. **Weekly Review** steps through each athlete with an editable brief, then lets you mark them reviewed. It can also draft a message for you to send yourself.

## How suggestions work

- **Deterministic calculations** (baselines, FTP or CSS derivations, countdowns) are plain code in `server/calc.js`, with unit tests.
- **Coach-defined rules** (completion threshold, wellbeing thresholds, maximum progression in suggestions, recovery guides after A, B and C races) are yours, set in Settings → Coaching rules.
- **AI suggestions** are kept separate. On the AI assist tab you export a summary, paste it into ChatGPT or Claude yourself, then paste the reply back. It is saved as an unverified AI suggestion, and nothing in the plan changes until you change it.
- A suggestion that would change the plan shows the action, the data it used (with dates), its reasoning, uncertainty and missing information, and a conservative alternative. It changes nothing until you approve it. With fewer than 4 weeks of data, it says what is missing instead of guessing.
- The app does not predict injuries, does not diagnose, and does not prescribe rehabilitation. Athlete-reported issues are flagged for your review.

## Calendar

The app publishes a one-way **coaching calendar**. It never reads or edits your other calendars.

- **Apple Calendar (recommended):** File → New Calendar Subscription, then paste the link from the Calendar page. Event IDs are stable, so edits update events and deleted records disappear. The calendar refreshes only while the app is running, so use the login item if you want it always current.
- **Google Calendar sync (shows in Notion Calendar):** one-way sync into a separate Google calendar called **Coaching**. Set it up on the Calendar page. You paste a small script into script.google.com in your own Google account and deploy it as a web app, then paste its link into the app. Nothing is sent until you click **Switch on**, and the list of events on the Calendar page is exactly what is sent. The script only writes to the Coaching calendar and only touches events the app created (they carry a hidden tag), so your main calendar and hand-made events are never changed. It syncs about 20 seconds after a change and every hour while the app runs. Repeating birthdays stay in the Apple feed only. To stop, click **Switch off** or **Disconnect**, and delete the Coaching calendar in Google if you want the events gone.
- **Notion Calendar** shows your Google or iCloud calendars, so the Google Calendar sync appears there automatically.
- You choose what is published: races, calls, testing windows, plan reviews, camps, travel, and birthdays (off by default, private). Titles use initials by default. Workouts and sample athletes are never published.
- Call times are stored in the athlete's time zone and published in UTC, so daylight-saving changes are handled.

## Integrations: what is and isn't possible (checked October 2026)

| Service | Status for a personal coaching tool | What this app does |
|---|---|---|
| TrainingPeaks | The API is for approved commercial developers only, and TrainingPeaks says it is "not available for personal use" ([TrainingPeaks](https://www.trainingpeaks.com/blog/an-update-on-trainingpeaks-partner-api/)). | Imports the TrainingPeaks **Workouts CSV export** (field mapping, preview, dedupe). |
| Garmin Connect | Business developer program. New applications were reported paused in 2026, with no reopening date ([Terra, Sep 2026](https://tryterra.co/blog/garmin-connect-developer-program-pause); [Garmin](https://developer.garmin.com/gc-developer-program/overview)). | Use CSV exports for now (Garmin data usually reaches you through TrainingPeaks anyway). |
| Strava | Self-serve API, but the November 2024 terms restrict showing one user's data to another person and using data for AI ([DC Rainmaker](https://www.dcrainmaker.com/2024/11/stravas-changes-to-kill-off-apps.html)). Check the current agreement before building anything. | Not connected. CSV import works for Strava bulk exports. |

No integration is mocked. Anything shown in the app came from your typing or your files.

## Costs

- **Running costs:** £0. Node.js, SQLite and the app are free, and there is no hosting.
- **Optional later:** an AI API (pay per use, a few pence per review) or Google Calendar API (free for personal use, but setup is required).

## Credentials

None. The app needs no accounts or API keys. The calendar link contains a random private key, so keep the link to yourself.

## Security notes

- The server listens only on `127.0.0.1`, so other devices on your network can't reach it.
- It rejects requests addressed to other host names and write requests from other websites, which protects against attacks from pages open in the same browser.
- Your Mac's login and FileVault protect the data at rest. Backups are not encrypted, so store copies somewhere you trust.

## Data limitations

- Weeks with no data are shown as **No data**, never as zero. Enter 0 only when the athlete genuinely did nothing.
- The TrainingPeaks CSV export does not say which method produced each TSS value, so loads are labelled "TrainingPeaks TSS (sport)" and kept per sport.
- Test derivations (95% of 20-minute power, 75% of ramp 1-minute power, CSS) are standard conventions. They are shown as estimates with their method.
- Planned workouts in a TrainingPeaks export count as planned volume. Rows not yet completed are not counted as missed.

## Development

```bash
npm test     # 37 tests: calculations, imports, DST, approval flow, backup/restore, Google sync, two-Mac sharing
npm start    # same as the .command file, without the Node version check
```

There are zero npm dependencies. The server code is in `server/` (`calc.js` for pure logic, `service.js` for data and rules, `app.js` for HTTP) and the browser code is in `public/`. SQLite schema migrations are in `server/db.js`.

## Not built yet (next phases)

- FIT/GPX activity-file import.
- An API-powered AI assistant, with explicit per-request consent.
- Two-way calendar sync, which needs conflict handling designed first.
- Multi-athlete season overview (Gantt across the roster).
