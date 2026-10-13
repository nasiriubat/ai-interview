# Proposed default for `campaign.consentText`

For the orchestrator to apply in `packages/shared/src/settings.ts`. The web agent does not edit
that file (another agent owns it). Source: `copy-audit.md` section 0, checked against the
implementation on 2026-10-13.

## Why the current default must change

Current default (English only, two sentences):

> This interview is recorded to help your organization understand how work is done. You can pause, stop, or delete your answers at any time.

- It is shown unchanged to Finnish participants (the field is a plain string with no per-language
  variant).
- It does not say that the answers are processed by the AI services the organization configured
  (NFR-02), how long they are kept (`privacy.retentionMonths`, default 24; audio
  `privacy.audioRetentionDays`, default 365), that identified answers may be read by admins
  (`privacy.rawTranscriptsVisibleTo`), or that combined totals survive deletion.
- "Delete your answers" is true, but deletion today removes messages, events, facts, attachments
  and their stored bytes only; the participant row and the invitation email remain.

## Proposed default, English

> This interview is a conversation with an AI interviewer, run on behalf of your organization. Your answers, any files you attach and any voice recordings are kept so that your organization can understand how work is actually done. They are processed by the AI services your organization has chosen. You can pause, stop or delete your answers at any time from the interview menu; deleting removes your answers, recordings and files right away, while totals already combined with other people's answers remain and cannot be traced to you. Your data is deleted automatically after your organization's retention period.

## Proposed default, Finnish (sinuttelu)

> Tämä haastattelu on keskustelu tekoälyhaastattelijan kanssa, ja se tehdään organisaatiosi toimeksiannosta. Vastauksesi, liittämäsi tiedostot ja mahdolliset äänitallenteet säilytetään, jotta organisaatiosi ymmärtää, miten työ oikeasti tehdään. Niitä käsittelevät organisaatiosi valitsemat tekoälypalvelut. Voit keskeyttää, lopettaa tai poistaa vastauksesi milloin tahansa haastattelun valikosta. Poisto hävittää vastauksesi, tallenteesi ja tiedostosi heti; muiden vastauksiin jo yhdistetyt lukumäärät säilyvät, mutta niitä ei voi yhdistää sinuun. Tietosi poistetaan automaattisesti organisaatiosi säilytysajan jälkeen.

## How to apply

1. The settings catalog has one string per scope, so a single default cannot be both. Two options:
   - Cheapest: set the English text as the platform default and let Finnish tenants override
     `campaign.consentText` at tenant or campaign scope with the Finnish text.
   - Better (small code change in the settings service, as `copy-audit.md` recommends): keep the
     catalog default as the English text and resolve a localized default by the campaign or template
     language when no override exists. The Finnish text above is the second value.
2. Revisit the final sentence once the retention figure can be interpolated
   (`privacy.retentionMonths`); until then it deliberately says "your organization's retention
   period" and states no number.
3. Changing the default changes the consent hash that is recorded when a participant consents
   (`participant/service.ts` hashes the resolved text), so participants who consented under the old
   text keep the old hash. That is intended: they agreed to different words.
4. The web copy on the arrival screen (`participant.arrival.stored*`, `deletePromise`) was changed
   in the same commit series to say the same things, so the arrival screen and the consent text
   agree.
5. Counsel review (program decision 7) applies to this wording.

## Not claimed

- "Nothing is shared outside your organization" is not used anywhere: the configured model, STT
  and TTS providers receive the content.
- "This link stops working" after deletion is not claimed. The participant token still resolves
  to an empty, `deleted` session today; invalidating it is Security M1.
- No deletion confirmation email is promised until FR-13's email exists.
