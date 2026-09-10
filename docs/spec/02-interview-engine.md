# 02 Interview engine

One loop that reads a template. Modality-agnostic: text, options, recorded voice, and
real-time voice all produce the same messages.

## Turn object

Each assistant turn is structured output, not a string:

```
{
  message: string,                       // what is shown and, in voice, spoken
  widget?: SingleChoice | MultiChoice | Scale | Ranking | YesNo,
  voice?: { shortForm: string },         // how options are read aloud
  stateDelta: { coverage, profile, openThreads, decisions, facts },
  reason: string                         // why this question, for the admin replay view
}
```

Widgets: single or multi choice, each option with an expandable detail and always an
"Other" that the participant types or speaks; a 1 to 5 scale; a ranking of up to five
items; yes/no with a follow-up. The participant can ignore any widget and answer in
chat. The model decides per turn whether a widget helps; the template caps frequency.

## State per session

- Coverage per area: `untouched`, `partial`, `covered`, with what is known and what is missing.
- Participant profile: role, seniority, chosen path, technical level signals, preferred answer length, style.
- Open threads: mentioned processes, problems, or tools worth a follow-up, each with a priority.
- Decisions (requirements sessions): every accepted default and choice.
- Facts extracted so far.
- Turn count, follow-ups used per area, rolling summary.

## Choosing the next question

1. If the last answer is ambiguous or contradicts earlier state: clarify. One question.
2. Else if the last answer surfaced a process or problem and follow-ups remain for the area: go one level deeper.
3. Else take the highest-priority open thread in an uncovered area.
4. Else move to the next area in template order, skipping covered areas.
5. The model receives the layered context (`03`), the area's instructions, and returns the turn object. The state delta is persisted before the message streams (NFR-04).

## Stopping and resuming

- Stop when all areas are covered, max turns is reached, or the participant says they are done. Then the closing question ("Anything important I did not ask about?"), then the end-of-session summary (`06`).
- Resume within the campaign window with a two-sentence recap, continuing from state, not from the transcript.

## Difficult participants

- Minimal answers: switch to concrete easy prompts and offer widgets; after three minimal answers in a row, shorten to essential areas (role, repetitive tasks, problems).
- Off topic or venting: acknowledge in one sentence, capture anything useful as an open thread, return to the area.
- Hostile or distressed: stop probing, offer to end, flag the session for the admin without storing a judgment about the person.
- Vague about tools: ask what the screen looks like rather than which system.

## Paths and the context block (requirements template)

- The user picks technical or nontechnical on the first screen, with one line each on what changes. The engine offers a switch if the signals disagree; the user can switch anytime.
- Nontechnical: behavior questions in plain language; technical decisions are derived and presented as recommendations with a one-line reason; the spec still contains the full technical section, marked recommended.
- Technical: architecture, API, data, and hosting questions; alternatives recorded; conflicts with the context block flagged.
- The context block runs before any feature question and changes later questions, defaults, and the shape of the spec.

## Guardrails

- One question per turn, never a list. Maximum assistant turn length is a template setting.
- Never asks for information the privacy mode excludes.
- Never suggests solutions in discovery interviews; always offers a default in requirements interviews.
- Every turn is an event, replayable by admins and by evals.

## Admin knobs (ADM-ENGINE)

Area order and instructions, follow-up limits, minimal-answer threshold, max turns,
closing question text, widget frequency cap, allowed widget types, turn length, path
selection on or off, context block questions, per-path behavior.
