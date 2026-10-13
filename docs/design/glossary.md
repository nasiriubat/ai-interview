# Glossary

One term per concept, in both languages. This is the vocabulary of everything a person reads in
`apps/web` (the strings in `apps/web/src/i18n/en.ts` and `fi.ts`). Code, the API, the database and the
spec keep their own names: the UI word is not the identifier.

The rules behind it are in [content-guide.md](./content-guide.md); the decisions are D-130 to D-137
in `docs/discovery/decisions.md`.

## Terms

| Concept                                   | English (use)                                          | Finnish (use)                                        | Stop using (en / fi)                                                   | Where                                         |
| ----------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| One person's conversation                 | interview                                              | haastattelu                                          | session / istunto, sessio                                              | everywhere in the UI; "session" stays in code |
| A run of a template, with a link          | campaign (admins), interview round (participants)      | kampanja (admins), haastattelukierros (participants) | participants never see "campaign" / "kampanja"                         | admin; participant arrival and error screens  |
| Requirements conversation                 | requirements interview                                 | vaatimushaastattelu                                  | requirements session, requirements discovery / vaatimusistunto         | admin                                         |
| The AI that asks the questions            | the interviewer                                        | haastattelija                                        | the AI, the model, the engine, bot / tekoäly, moottori                 | participant and admin                         |
| The company using the product             | your organization                                      | organisaatiosi                                       | tenant / asiakas (kept only on operator screens)                       | settings, providers, budgets, lists           |
| Person answering                          | participant                                            | osallistuja                                          | user, respondent / käyttäjä, vastaaja                                  | admin                                         |
| Person who owns a requirements session    | owner                                                  | omistaja                                             | idea owner                                                             | admin                                         |
| Item extracted from answers               | extracted item (admin), "what was noted" (participant) | poiminta, "mitä kirjattiin"                          | fact / fakta, havainto                                                 | results statistics, summary                   |
| Issue raised in a requirements session    | finding                                                | havainto                                             | issue / ongelma                                                        | templates, workspace                          |
| Finding-detection setting                 | strictness                                             | tiukkuus                                             | aggressiveness / aggressiivisuus                                       | templates, settings                           |
| One analysed cluster                      | opportunity                                            | mahdollisuus                                         | idea                                                                   | results                                       |
| Opportunity category                      | solution class                                         | ratkaisuluokka                                       | class / luokka                                                         | results, dashboard                            |
| 0 to 100 number                           | score                                                  | pisteet                                              | rank / sijoitus (only as a verb: "ranked")                             | results, dashboard                            |
| Output of a requirements interview        | specification                                          | määrittely                                           | spec (except the file names spec.md and spec.json)                     | workspace                                     |
| A frozen specification                    | version                                                | versio                                               |                                                                        | workspace                                     |
| Archive for coding agents                 | agent bundle                                           | agenttipaketti                                       |                                                                        | versions                                      |
| What a requirements interview starts from | starting brief                                         | lähtötiedot                                          | hand-off / siirtotiivistelmä                                           | promote dialog                                |
| Interview blueprint                       | template                                               | mallipohja                                           | pohja                                                                  | admin                                         |
| Template that ships with the product      | built-in template                                      | vakiopohja                                           | shipped / alustan mukana                                               | templates                                     |
| One section of an interview               | topic                                                  | aihealue                                             | coverage area, area (admin) / kattavuusalue                            | templates; participant progress shows names   |
| Questions asked first                     | background questions                                   | taustakysymykset                                     | context block / kontekstilohko                                         | templates                                     |
| Choice controls in a turn                 | answer options                                         | vastausvaihtoehdot (UI), vastauselementit (template) | widget / vimpain                                                       | templates, participant                        |
| What a model call is for                  | task                                                   | tehtävä                                              | purpose / käyttötarkoitus                                              | model assignment, spend                       |
| Task to provider and model                | model assignment                                       | mallivalinta                                         | route, routing / reitti, reititys                                      | navigation, model assignment                  |
| Vendor of models                          | provider                                               | palveluntarjoaja (navigation), tarjoaja (body text)  |                                                                        | providers                                     |
| Spending limit                            | budget                                                 | budjetti                                             | cap (only as "cap per campaign")                                       | budgets                                       |
| Level a setting or budget applies at      | level                                                  | taso                                                 | scope / laajuus                                                        | settings, budgets, lists                      |
| Named or not named participation          | with name / anonymous                                  | omalla nimellä / anonyymisti                         | identified (in participant text); it stays the template's privacy mode | participant; admin template form              |
| Stop an interview for now                 | pause                                                  | keskeytä                                             |                                                                        | participant                                   |
| Stop the interviewer speaking             | interrupt                                              | keskeytä puhe                                        |                                                                        | participant                                   |
| Deactivate an organization                | suspend                                                | jäädytä                                              | keskeytä                                                               | operator                                      |
| Withdraw an invitation                    | revoke                                                 | peru                                                 | peruuta (reserved for Cancel)                                          | campaigns, invitations                        |
| Live voice                                | live voice call                                        | äänipuhelu                                           | reaaliaikainen ääni                                                    | participant, settings                         |
| Voice answer                              | recorded answer                                        | äänivastaus                                          |                                                                        | participant                                   |
| Start the deletion of one's answers       | delete my data (button), "your answers" (sentence)     | poista tietoni, "vastauksesi"                        | "everything you said", "your data" in sentences about what is removed  | participant                                   |
| Overview page of the admin                | overview                                               | yleiskatsaus                                         | dashboard / kojelauta                                                  | admin navigation                              |

## Status words

| Status                                  | English         | Finnish            |
| --------------------------------------- | --------------- | ------------------ |
| invitation sent                         | Sent            | Lähetetty          |
| interview created                       | Not started     | Ei aloitettu       |
| consent given                           | Ready to start  | Valmis aloittamaan |
| finding raised                          | Raised          | Esitetty           |
| finding deferred                        | Deferred        | Lykätty            |
| organization suspended                  | Suspended       | Jäädytetty         |
| opportunity in a requirements interview | In requirements | Määrittelyssä      |
| opportunity shortlisted                 | Shortlisted     | Kärkilistalla      |

The full set of labels for identifiers (providers, tasks, effort levels, budget scopes, template
fields, settings and their options) lives in `t.enums` in the locale files and is read through
`label(kind, value)` in `apps/web/src/lib/i18n/enums.ts`.

## Keeping this file true

- A new concept gets a row here before it gets a string.
- A word in the "Stop using" column does not appear in `en.ts` or `fi.ts` except where the row says
  where it may. Reviewers check the diff of the locale files against this table.
- Operator screens (`admin.operator.*`, the platform navigation group) may say "tenant" and
  "asiakas": the operator talks about customers, a tenant's admins talk about their organization.
