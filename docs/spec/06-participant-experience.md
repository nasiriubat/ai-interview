# 06 Participant experience

The bar: it should feel like talking to a capable assistant. Streaming, instant,
interactive, no forms.

## Links and uniqueness (FR-10, FR-04)
- Email invitations: the admin pastes or uploads addresses; each person gets a personal one-time link that binds the session to the invitation. Reopening resumes; it never starts a second session.
- Shareable link: the person enters an email, receives a six-digit code, and the verified email binds the session. Same email, same session.
- Anonymous campaigns still verify email for uniqueness but store only a salted hash on the campaign, never on the session. The admin sees counts and can remind non-responders without knowing whose session is whose.
- Options: restrict to company domains; turn verification off for an open link (duplicates accepted); invitations expire with the campaign.
- External requirements users (consultancy clients) use the same mechanics; their sessions are owned by the inviting admin.

## Arrival
Company name, a two-sentence purpose, expected length, what is stored, how to delete
it. Participation mode shown or chosen. One button to start. No account.

## Composer
Chat by default; mode switch for options view and live voice, remembered per
participant, changeable mid-session. Attach files or a photo. Voice button for a
recorded answer in any mode.

## Turns
The interviewer streams. Widgets render below the message; "Other" accepts typing or
speech; answering in chat is always allowed. A small progress indicator by area; tap
an area to skip it or come back later.

## Resume, control, ending
Closing the tab loses nothing; the link reopens with a two-sentence recap. Pause,
"I'm done", and "delete my data" are one tap away; deletion is confirmed on screen and
by email when identified. Ending: closing question, then an editable summary of what
was captured, a thank-you, and what happens next. Nothing about opportunities.

## Live voice
Full-screen mode with captions of both sides, interruptible, widgets read aloud in
short form. Falls back to recorded voice, then text, without losing the session.

## Accessibility and devices
Mobile-first, keyboard navigable, screen-reader labeled, captions on all audio, phone
browser without an app. WCAG 2.2 AA is the target.
