# marketing: screenshots from a running stack

`src/capture.ts` photographs the important pages of a running installation for marketing material
(D-469). It signs in as a tenant admin through the emailed link, read from Mailpit's API, finds the
campaign and the requirements interview to show, and writes numbered PNGs and an `index.md` (what
each picture shows and where it is best used) into `marketing/screenshots/`.

It photographs what is there. Run it after a simulation has produced data: a campaign with
finished interviews and an analysis, and a requirements interview with at least two versions. The
material in `marketing/` was made from the run described in `docs/team/simulation-2026-10-15.md`.

## Running it

1. A stack with Mailpit as its mail relay. Locally: `pnpm stack:up` (web on :3000, Mailpit on
   :8025), or the host processes from `docs/RUNNING.md` with `SMTP_HOST=localhost SMTP_PORT=1025
SMTP_SECURITY=none`.
2. Data to show (see above), made through the product: a campaign, interviews, an analysis, a
   requirements interview with two generated versions.
3. Then:

```bash
pnpm install
pnpm --filter @aidp/web exec playwright install chromium   # once
ADMIN_EMAIL=laura.koski@kestrel-health.example \
BASE=http://localhost:3000 MAILPIT=http://localhost:8025 \
  pnpm --filter @aidp/marketing capture
```

| Variable       | Default                 | Meaning                                                                                                                                                   |
| -------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_EMAIL`  | (required)              | A tenant admin; the sign-in link is read from Mailpit                                                                                                     |
| `BASE`         | `http://localhost:3000` | Where people open the web app                                                                                                                             |
| `MAILPIT`      | `http://localhost:8025` | Mailpit's web address                                                                                                                                     |
| `OUT`          | `marketing/screenshots` | Output directory (relative to where you run it; with `--filter` that is `tools/marketing`, so pass an absolute path)                                      |
| `CAMPAIGN`     | the first listed        | Campaign id to photograph                                                                                                                                 |
| `REQUIREMENTS` | the first listed        | Requirements interview id to photograph                                                                                                                   |
| `INTERVIEW`    | off                     | `1` takes two short real interviews through the share link for the chat, voice and summary shots. It costs a handful of model calls on the stack's routes |
| `MIC_WAV`      | none                    | A WAV for Chromium's fake microphone, for the voice clip shot (macOS: `say -o a.aiff "..." && afconvert -f WAVE -d LEI16@16000 a.aiff a.wav`)             |
| `ONLY`         | all                     | Comma-separated numbers or name parts, to retake some shots (`ONLY=13,report`)                                                                            |

The report PDF's first page is rasterised with `pdftoppm` (poppler) when installed, else with
`sips` on macOS; otherwise that one shot is skipped and the script says where the PDF is.

## After a run: look at every picture

A script cannot tell a good screenshot from a bad one. Open each file and retake (`ONLY=...`) any
that is clipped, empty, still loading, shows a development overlay, a toast over the content, a
real company's name, or anything that looks like a key. Then update `marketing/screenshots/index.md`
if a picture's content changed.

## What it never does

It reads no provider key and prints no secret. The sign-in link it reads from Mailpit is used once
and not written anywhere; the browser state file lives in the system temp directory.

## Tests

`pnpm --filter @aidp/marketing test` checks the pure parts: configuration, mail parsing and the
shot list.
