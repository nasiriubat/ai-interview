# Marketing material (October 2026)

Screenshots and a voice-over script made from a real run of the product on 2026-10-15. It replaces
any earlier material.

**Everything shown is a simulated demo.** "Kestrel Health", its clinics and every person are
fictional; their interview answers were played by a language model. The product itself was running
(production builds, real low-cost models, real email through a mail catcher); nothing was mocked up
or retouched. "Kestrel Discovery" is the demo's product name, set under Settings, Branding. The run
and everything fixed during it are in `docs/team/simulation-2026-10-15.md`.

## What is here

| Path                               | What                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `screenshots/NN-name.png`          | 30 pictures at 2x: desktop 1440 and phone 390, English and Finnish, light and one dark                                |
| `screenshots/index.md`             | What each picture shows and where it is best used                                                                     |
| `voiceover/script.txt`             | Full narration, 3 min 22 s, 15 scenes, each tagged with its screenshot and timing, with performance cues and a legend |
| `voiceover/script-plain.txt`       | The same words without cues, for a narrator's prompter or a text-to-speech engine                                     |
| `voiceover/script.srt`             | Subtitles, cue times inside each scene                                                                                |
| `voiceover/script-60s.txt`, `.srt` | A 60-second cut                                                                                                       |

## How it was produced

1. The stack was started as an installer would (`docs/team/simulation-2026-10-15.md`, "How it
   ran"), with Mailpit as the mail relay.
2. A campaign, six discovery interviews, four analysis versions, and two requirements interviews
   with three specification versions were made through the web UI by scripted browsers.
3. `tools/marketing/capture.ts` signed in through the emailed link and photographed the pages
   (`tools/marketing/README.md`); with `INTERVIEW=1` it took two short fresh interviews for the
   chat, voice clip and summary pictures, the voice answer through Chromium's fake microphone.
4. Every picture was opened and checked; clipped, loading or wrong ones were retaken.
5. `pnpm --filter @aidp/marketing voiceover ../../marketing/voiceover/script.txt` writes the
   `.srt` and plain files from a script; a test fails if they drift apart or a scene names a
   picture that does not exist.

## Cost

The whole run, interviews, analysis, specifications and the capture, cost under 0.50 USD: 0.42 in
the product's own ledger and under 0.05 for the simulated people. That is a figure for this
simulated run on low-cost models, not a price.

## Rules the words follow

- Only claims with status `Built` in `docs/team/claims-2026-10.md`, in the present tense; a default
  is called a default ("at least three people, the default").
- The difference from just asking a chatbot is said plainly: the same template for everyone, items
  on a fixed schema counted across the campaign, a threshold before anything is attributed, a
  result that may be "not AI", a versioned specification.
- No customers, no statistics. The only numbers are on screen and come from this simulated run.
- No interview length in minutes (claims B9).

## What to re-record or retake

- **Real branding.** Before the client uses this outside the company, set their product name and
  logo under Settings, Branding and rerun `capture.ts` (about five minutes against a populated stack).
- **Voice.** The scripts are written to be read by a person; `script-plain.txt` also works with a
  text-to-speech engine. Record at about 140 words a minute; the scene timings assume it.
- **10-participant-voice-phone.png** depends on the fake microphone; if the transcript is cut, rerun
  with `ONLY=10 INTERVIEW=1 MIC_WAV=... MIC_SECONDS=<length of the WAV>`.
- **Finnish voice-over** is not written; the Finnish screenshots (27 to 29) are for Finnish decks.
  The demo campaign's welcome text is English, so it is English on the Finnish arrival picture.
- **Pictures 06 and 07** are of a second campaign ("round two") with no finished interviews, so the
  arrival screen says "As long as you need" rather than a duration. The demo's first campaign would
  show "About 3 minutes": its interviews were answered by a simulator, and claims B9 forbids quoting
  that (D-470).
