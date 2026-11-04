# Marketing material (November 2026)

Screenshots and a voice-over script made from a real run of the product on 2026-11-04, every model
call on Meta's Model API (Muse Spark 1.3). It replaces the October material.

**Everything shown is a simulated demo.** "Kestrel Health", its clinics and every person are
fictional; their interview answers were played by a language model (Muse Spark 1.3 at minimal
reasoning effort, through the live-run harness). The product itself was running (production builds,
real email through a mail catcher); nothing was mocked up or retouched.

## What is here

| Path                               | What                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `screenshots/NN-name.png`          | 33 pictures at 2x: desktop 1440 and phone 390, English and Finnish, light and one dark                                |
| `screenshots/index.md`             | What each picture shows and where it is best used                                                                     |
| `voiceover/script.txt`             | Full narration, 3 min 22 s, 15 scenes, each tagged with its screenshot and timing, with performance cues and a legend |
| `voiceover/script-plain.txt`       | The same words without cues, for a narrator's prompter or a text-to-speech engine                                     |
| `voiceover/script.srt`             | Subtitles, cue times inside each scene                                                                                |
| `voiceover/script-60s.txt`, `.srt` | A 60-second cut                                                                                                       |

## How it was produced

1. The live-run harness started the stack on its own database with only `MUSE_API_KEY`, so the
   bootstrap created the Meta provider and every text route on `muse-spark-1.3` (D-495), with
   Mailpit as the mail relay and the production web server in front:

   ```bash
   LIVE_PROVIDER=meta LIVE_RUN_ID=demo LIVE_DB_NAME=ai_discovery_demo LIVE_API_PORT=4300 \
   LIVE_WEB_URL=http://localhost:3300 LIVE_SMTP_HOST=localhost LIVE_TENANT_NAME="Kestrel Health" \
   LIVE_ADMIN_EMAIL=laura.koski@kestrel-health.example DEMO_STATE=<file> \
     npx tsx tools/live-run/src/demo-stack.ts
   ```

2. `demo-discovery.ts` ran three campaigns (`DEMO_CASE=ops`, `billing`, `handover`; 21 simulated
   interviews), `demo-analysis.ts` their analyses, and `demo-requirements.ts` three requirements
   interviews: two promoted from opportunities and one from a one-line idea, revised into a
   second version. State passes between the steps through `DEMO_DIR`.
3. `tools/marketing/capture.ts` signed in through the emailed link and photographed the pages
   (`tools/marketing/README.md`); with `INTERVIEW=1` it took two short fresh interviews for the
   chat, dictation and summary pictures, the spoken answer through Chromium's fake microphone.
4. Every picture was opened and checked; wrong ones were retaken.
5. `npx tsx tools/marketing/src/voiceover.ts marketing/voiceover/script.txt` writes the `.srt` and
   plain files from a script; a test fails if they drift apart or a scene names a picture that does
   not exist.

## Cost

The whole run cost 3.99 USD in the product's own ledger: 911 calls, every language call on
`muse-spark-1.3`, the dictated answer transcribed on the server. The spend picture was taken at 3.82
USD and 862 calls, before the capture's own two interviews. The simulated people cost another 0.88
USD. That is a figure for this simulated run, not a price.

## Rules the words follow

- Only claims with status `Built` in `docs/team/claims-2026-10.md`, in the present tense; a default
  is called a default ("at least three people, the default").
- The difference from just asking a chatbot is said plainly: the same template for everyone, items
  on a fixed schema counted across the campaign, a threshold before anything is attributed, a
  result that may be "not AI", a versioned specification.
- No customers, no statistics. The only numbers are on screen and come from this simulated run.
- No interview length in minutes (claims B9).

## What to re-record or retake

- **Real branding.** Before a client uses this outside the company, set their product name and
  logo under Settings, Branding and rerun `capture.ts` (about five minutes against a populated stack).
- **Voice.** The scripts are written to be read by a person; `script-plain.txt` also works with a
  text-to-speech engine. Record at about 140 words a minute; the scene timings assume it.
- **10-participant-voice-phone.png** depends on the fake microphone; rerun with
  `ONLY=10 INTERVIEW=1 MIC_WAV=... MIC_SECONDS=<length of the WAV>`.
- **Finnish voice-over** is not written; the Finnish screenshots (27 to 29) are for Finnish decks.
- **Interview length.** The arrival pictures show a duration measured from simulated interviews;
  claims B9 forbids quoting it (D-470), so crop it out where the words would rely on it.
