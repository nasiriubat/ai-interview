/**
 * Writes the replay fixtures under evals/fixtures/<templateKey>/<persona>.json (D-192).
 *
 *   pnpm --filter @aidp/evals exec tsx tools/gen-fixtures.ts
 *
 * Deterministic: no network, no randomness. The output is committed and reviewed like code; CI
 * never runs this. Edit the scenarios or the persona builders here, regenerate, and re-record the
 * baseline (`UPDATE_EVAL_BASELINE=1 pnpm --filter @aidp/evals test`).
 *
 * Each fixture has 60 participant turns. Labels say which requirement, note or fact a turn
 * introduces; gold requirements and facts are what a perfect capture would hold; `modelBehavior`
 * says where the recorded model breaks its reply.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureSchema, type Fixture, type Persona } from "../src/fixture.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

// ---------- requirements scenarios ----------

interface Req {
  title: string;
  terms: string[];
  acceptance: string[];
  scope: "mvp" | "future";
  say: string;
  terse: string;
}
interface ReqScenario {
  key: string;
  idea: string;
  users: string;
  rules: string;
  technical: string;
  data: string;
  integrations: string;
  security: string;
  reqs: Req[];
}

const SCENARIOS: Record<string, ReqScenario> = {
  charting: {
    key: "charting",
    idea: "Nurses on our ward type every note twice, once into the patient system and once into a spreadsheet, and we want to type it once.",
    users: "Ward nurses write the notes and the charge nurse reviews them every shift.",
    rules: "A note may not be edited after the charge nurse has signed it.",
    technical: "It should be a web app that runs on the hospital intranet and works on the ward tablets.",
    data: "We keep patients, notes, shifts and sign-offs, and every note belongs to one patient and one shift.",
    integrations: "It has to read patients from the hospital patient system and write notes back to it.",
    security: "Only staff on the ward may see its patients, and every read of a note is logged.",
    reqs: [
      {
        title: "Enter a ward note once",
        terms: ["note", "once"],
        acceptance: ["A saved note appears in the patient system"],
        scope: "mvp",
        say: "A nurse must be able to enter a ward note once and have it reach the patient system without retyping it.",
        terse: "Enter notes once.",
      },
      {
        title: "Charge nurse sign-off",
        terms: ["sign-off"],
        acceptance: ["A signed note can no longer be edited"],
        scope: "mvp",
        say: "The charge nurse needs to sign off the notes of a shift, and a signed note is locked.",
        terse: "Sign-off by charge nurse.",
      },
      {
        title: "Shift handover summary",
        terms: ["handover"],
        acceptance: ["A one page summary lists the open items"],
        scope: "mvp",
        say: "At the end of a shift the system should produce a handover summary of open items for the next nurse.",
        terse: "Handover summary.",
      },
      {
        title: "Search notes by patient",
        terms: ["search"],
        acceptance: ["Notes of one patient list newest first"],
        scope: "mvp",
        say: "Nurses must be able to search notes by patient and see the newest first.",
        terse: "Search by patient.",
      },
      {
        title: "Voice dictation of notes",
        terms: ["dictat"],
        acceptance: ["Dictated text appears in the note field"],
        scope: "future",
        say: "Later it would be nice to dictate a note by voice instead of typing.",
        terse: "Voice dictation, later.",
      },
      {
        title: "Export notes to Excel",
        terms: ["excel"],
        acceptance: ["A shift exports to a spreadsheet file"],
        scope: "future",
        say: "Managers want to export a shift's notes to Excel, but that can wait for a later version.",
        terse: "Excel export, later.",
      },
      {
        title: "Alert on missing vitals",
        terms: ["vitals"],
        acceptance: ["A banner shows when vitals are older than four hours"],
        scope: "mvp",
        say: "The system should warn a nurse when a patient's vitals have not been charted for four hours.",
        terse: "Warn on missing vitals.",
      },
      {
        title: "Work offline on the ward",
        terms: ["offline"],
        acceptance: ["Notes entered offline sync when the network returns"],
        scope: "future",
        say: "The ward wifi drops, so working offline and syncing later would help, in a later version.",
        terse: "Offline mode, later.",
      },
    ],
  },
  roster: {
    key: "roster",
    idea: "Our cleaning company plans shifts in a shared spreadsheet and people double book. We want a small tool to assign cleaners to sites.",
    users: "The dispatcher plans the week, cleaners see their own shifts and site managers confirm the work.",
    rules: "A cleaner may not work more than ten hours in a day or be at two sites at the same time.",
    technical: "A mobile friendly web app is enough, hosted on a managed platform, with email notifications.",
    data: "Sites, cleaners, shifts and confirmations, and a shift belongs to one site and one cleaner.",
    integrations: "We export hours to the payroll provider as a CSV every month.",
    security: "Cleaners see only their own shifts, dispatchers see everything.",
    reqs: [
      {
        title: "Assign cleaners to sites",
        terms: ["assign"],
        acceptance: ["A shift shows one cleaner and one site"],
        scope: "mvp",
        say: "The dispatcher must be able to assign a cleaner to a site for a shift on a calendar.",
        terse: "Assign cleaners to sites.",
      },
      {
        title: "Block double booking",
        terms: ["double"],
        acceptance: ["Assigning a booked cleaner shows an error"],
        scope: "mvp",
        say: "The tool must refuse to double book a cleaner who is already on another site at that time.",
        terse: "No double booking.",
      },
      {
        title: "Cleaner sees own shifts",
        terms: ["own", "shifts"],
        acceptance: ["A cleaner logs in and sees only personal shifts"],
        scope: "mvp",
        say: "Each cleaner should see their own shifts for the week on their phone.",
        terse: "Cleaners see own shifts.",
      },
      {
        title: "Site manager confirms work",
        terms: ["confirm"],
        acceptance: ["A confirmed shift is marked done"],
        scope: "mvp",
        say: "The site manager must be able to confirm that the work was done for each shift.",
        terse: "Manager confirms work.",
      },
      {
        title: "Monthly hours export",
        terms: ["hours", "export"],
        acceptance: ["A CSV lists hours per cleaner"],
        scope: "mvp",
        say: "At month end we need an hours export per cleaner as a CSV file for payroll.",
        terse: "Monthly hours export.",
      },
      {
        title: "Shift swap requests",
        terms: ["swap"],
        acceptance: ["A swap needs dispatcher approval"],
        scope: "future",
        say: "Cleaners will want to swap shifts with each other, but that can come later.",
        terse: "Shift swaps, later.",
      },
      {
        title: "SMS reminders",
        terms: ["sms"],
        acceptance: ["A reminder is sent the evening before"],
        scope: "future",
        say: "An SMS reminder the evening before a shift would be nice, later on.",
        terse: "SMS reminders, later.",
      },
      {
        title: "Sick leave handling",
        terms: ["sick"],
        acceptance: ["A sick cleaner's shifts are flagged for reassignment"],
        scope: "mvp",
        say: "When a cleaner reports sick, their shifts must be flagged so the dispatcher can reassign them.",
        terse: "Sick leave flags shifts.",
      },
    ],
  },
  library: {
    key: "library",
    idea: "A small town library lends tools like drills and ladders from a notebook, and we want a simple lending system.",
    users: "The librarian lends and takes back items and members borrow and reserve them.",
    rules: "A member may borrow at most three tools at a time for seven days.",
    technical: "A simple web app on a cheap server, with a barcode scanner at the desk.",
    data: "Items, members, loans and reservations, an item has one condition note.",
    integrations: "We would like to send overdue reminders by email.",
    security: "Member contact details are private and only the librarian sees them.",
    reqs: [
      {
        title: "Lend an item to a member",
        terms: ["lend"],
        acceptance: ["A loan records item, member and due date"],
        scope: "mvp",
        say: "The librarian must be able to lend an item to a member and see the due date.",
        terse: "Lend item to member.",
      },
      {
        title: "Return an item",
        terms: ["return"],
        acceptance: ["A returned item becomes available"],
        scope: "mvp",
        say: "Returning an item should mark it available again and note its condition.",
        terse: "Return item.",
      },
      {
        title: "Reserve an item",
        terms: ["reserve"],
        acceptance: ["A reserved item cannot be lent to someone else"],
        scope: "mvp",
        say: "Members should be able to reserve an item that is on loan.",
        terse: "Reserve items.",
      },
      {
        title: "Overdue email reminders",
        terms: ["overdue"],
        acceptance: ["An email goes out the day after the due date"],
        scope: "mvp",
        say: "The system must email a member when a loan is overdue.",
        terse: "Overdue emails.",
      },
      {
        title: "Scan barcodes at the desk",
        terms: ["barcode"],
        acceptance: ["Scanning an item opens its record"],
        scope: "future",
        say: "Scanning a barcode at the desk would speed things up, which can come later.",
        terse: "Barcode scanning, later.",
      },
      {
        title: "Member self service page",
        terms: ["self"],
        acceptance: ["A member sees their own loans"],
        scope: "future",
        say: "Members could look at their own loans online, in a later version.",
        terse: "Member self service, later.",
      },
      {
        title: "Loan limit of three items",
        terms: ["limit"],
        acceptance: ["A fourth loan is refused"],
        scope: "mvp",
        say: "The system should stop a member from borrowing more than three items at once.",
        terse: "Three item limit.",
      },
      {
        title: "Monthly usage report",
        terms: ["report"],
        acceptance: ["A report lists loans per item"],
        scope: "future",
        say: "The council wants a monthly usage report, but not for the first version.",
        terse: "Usage report, later.",
      },
    ],
  },
};

// ---------- persona builders (requirements) ----------

const CONTEXT_ANSWERS = [
  "Probably a managed platform, we do not have servers.",
  "It has to work with the spreadsheet we use today and maybe the email system.",
  "A coding agent will build it, with me reviewing.",
  "I know spreadsheets well, not much else.",
  "We would like version one in about two months.",
  "The budget is small, a few hundred euros a month at most.",
  "About twenty people at launch.",
  "Nothing special, just keep personal data private.",
];
const TERSE_CONTEXT = [
  "Managed platform.",
  "The spreadsheet.",
  "A coding agent.",
  "Spreadsheets.",
  "Two months.",
  "Small.",
  "Twenty.",
  "Privacy.",
];
const DRIFT = [
  "Sorry, off topic, but did you see the weather forecast for the weekend?",
  "By the way my coffee machine broke this morning, it has been that kind of week.",
  "That reminds me, I need to book a dentist appointment before I forget.",
  "Anyway, the parking situation at the office is terrible lately.",
  "Not related, but we had a very long meeting about the new coffee budget.",
];
const CONFIRM = [
  "Yes, that is right.",
  "Correct, go on.",
  "That sounds fine to me.",
  "Yes, keep it that way.",
  "No, nothing to add there.",
  "Good, that works for us.",
];

function turnsFor(
  persona: Persona,
  s: ReqScenario,
): {
  turns: Fixture["turns"];
  gold: Fixture["goldRequirements"];
  flaws: Record<string, Fixture["modelBehavior"]["flaws"][string]>;
} {
  interface Item {
    text: string;
    labels: Fixture["turns"][number]["labels"];
  }
  const L = (
    labels: Partial<Fixture["turns"][number]["labels"]> = {},
  ): Fixture["turns"][number]["labels"] => ({
    requirements: [],
    facts: [],
    rescopes: [],
    offTopic: false,
    sections: [],
    ...labels,
  });
  const terse = persona === "terse";
  const reqs = terse ? s.reqs.slice(0, 5) : s.reqs;
  const queue: Item[] = [];
  for (let i = 0; i < 8; i++)
    queue.push({ text: terse ? TERSE_CONTEXT[i]! : CONTEXT_ANSWERS[i]!, labels: L() });
  queue.push({ text: terse ? "Double typing." : s.idea, labels: L({ sections: ["overview"] }) });
  queue.push({ text: terse ? "Staff." : s.users, labels: L({ sections: ["users"] }) });
  reqs.forEach((r, i) =>
    queue.push({ text: terse ? r.terse : r.say, labels: L({ requirements: [`R${i + 1}`] }) }),
  );
  queue.push({ text: terse ? "One rule." : s.rules, labels: L({ sections: ["rules"] }) });
  queue.push({
    text: terse ? "Web app." : s.technical,
    labels: L({ sections: ["technical"] }),
  });
  queue.push({ text: terse ? "Four tables." : s.data, labels: L({ sections: ["data"] }) });
  queue.push({ text: terse ? "Email." : s.integrations, labels: L({ sections: ["integrations"] }) });
  queue.push({ text: terse ? "Private." : s.security, labels: L({ sections: ["security"] }) });

  if (persona === "technical") {
    // Precise technical answers replace some of the generic ones.
    queue[8] = {
      text: `${s.idea} Constraints: single sign-on through Azure AD, PostgreSQL, and an audit trail on every write.`,
      labels: L({ sections: ["overview"] }),
    };
    queue[queue.length - 5] = {
      text: `${s.technical} Stack: TypeScript, Postgres, REST with an OpenAPI description, deployed in containers.`,
      labels: L({ sections: ["technical"] }),
    };
  }

  // Interleave: off-topic personas drift 40 percent of the time; everyone else confirms between items.
  const out: Item[] = [];
  let driftIndex = 0;
  for (const [i, item] of queue.entries()) {
    out.push(item);
    if (persona === "off_topic" && i >= 8 && out.length < 44) {
      out.push({ text: DRIFT[driftIndex++ % DRIFT.length]!, labels: L({ offTopic: true }) });
      if (i % 2 === 0) out.push({ text: DRIFT[driftIndex++ % DRIFT.length]!, labels: L({ offTopic: true }) });
    }
  }
  // Contradiction: a requirement introduced early is moved to future scope later.
  const turns: Fixture["turns"] = [];
  while (out.length < 60) {
    const k = out.length;
    out.push({ text: terse ? "Yes." : CONFIRM[k % CONFIRM.length]!, labels: L() });
  }
  out.slice(0, 60).forEach((item, i) => turns.push({ n: i + 1, text: item.text, labels: item.labels }));

  const turnOf = (reqId: string): number => turns.findIndex((t) => t.labels.requirements.includes(reqId)) + 1;
  const gold: Fixture["goldRequirements"] = reqs.map((r, i) => ({
    id: `R${i + 1}`,
    title: r.title,
    terms: r.terms,
    scope: r.scope,
    acceptance: r.acceptance,
    introducedAtTurn: turnOf(`R${i + 1}`),
  }));
  if (persona === "contradictory") {
    // R3 is first called essential, 14 turns later the owner moves it out of version one.
    const target = gold[2];
    const at = 30;
    if (target) {
      turns[at - 1] = {
        n: at,
        text: `On reflection, ${target.title.toLowerCase()} is not needed for version one, let us do that later.`,
        labels: L({ rescopes: [target.id] }),
      };
      target.scope = "mvp";
      target.finalScope = "future";
      target.rescopedAtTurn = at;
    }
  }

  // Where the recorded model breaks its reply, by answer number: the turns of requirements, since
  // that is where a break costs capture.
  const flaws: Record<string, Fixture["modelBehavior"]["flaws"][string]> = {};
  const kinds = [
    "marker_missing",
    "wrong_section",
    "descriptive_id",
    "malformed_json",
    "no_capture",
    "truncated",
    "rules_flood",
  ] as const;
  gold.forEach((g, i) => {
    if (i % 2 === 1) flaws[String(g.introducedAtTurn)] = kinds[Math.floor(i / 2) % kinds.length] as never;
  });
  flaws["6"] = "marker_missing"; // a context turn
  return { turns, gold, flaws };
}

function requirementsFixture(persona: Persona, scenarioKey: string): Fixture {
  const s = SCENARIOS[scenarioKey]!;
  const { turns, gold, flaws } = turnsFor(persona, s);
  const path = persona === "technical" ? "technical" : "nontechnical";
  const findings =
    persona === "contradictory"
      ? [
          {
            type: "contradiction",
            section: "functional",
            description: "A requirement is both essential and out of scope",
            resolution: "Decide its scope",
            default: "Move it to the future",
            confidence: "high",
          },
        ]
      : persona === "terse"
        ? [
            {
              type: "ambiguity",
              section: "nfr",
              description: "Performance is not defined",
              resolution: "Set a target",
              default: "2 seconds",
              confidence: "medium",
            },
          ]
        : [
            {
              type: "missing_decision",
              section: "security",
              description: "No sign-in method has been decided",
              resolution: "Choose how people sign in",
              default: "email link",
              confidence: "high",
            },
          ];
  const goldFindings: Fixture["goldFindings"] =
    persona === "terse"
      ? []
      : [
          persona === "contradictory"
            ? {
                id: "F1",
                type: "contradiction",
                section: "functional",
                turns: [turns.findIndex((t) => t.labels.requirements.includes("R3")) + 1, 30],
              }
            : { id: "F1", type: "missing_decision", section: "security", turns: [] },
        ];
  return FixtureSchema.parse({
    id: `requirements_discovery/${persona}`,
    version: 1,
    templateKey: "requirements_discovery",
    persona,
    path,
    turns,
    goldRequirements: gold,
    goldFindings,
    modelBehavior: { flaws, scans: [findings] },
    expect: {
      coverage: [
        { afterTurn: 12, covered: 1 },
        { afterTurn: 30, covered: 5 },
      ],
      endedWithin: 60,
    },
  });
}

// ---------- discovery scenarios ----------

interface DiscoveryScenario {
  who: string;
  role: string;
  daily: string;
  tasks: {
    name: string;
    say: string;
    terse: string;
    terms: string[];
    frequency: "daily" | "weekly" | "monthly" | "hourly" | "rarely";
    minutes: number;
    tools: string[];
    pain: number;
  }[];
  flows: { from: string; to: string; what: string; say: string; terms: string[] }[];
  pains: { description: string; say: string; terms: string[]; severity: number }[];
}

const NURSE: DiscoveryScenario = {
  who: "nurse",
  role: "I am a nurse on the surgical ward and I look after eight patients per shift.",
  daily: "Mornings are rounds and medication, then charting, then calls to the lab for results.",
  tasks: [
    {
      name: "Charting in two systems",
      say: "Charting happens twice, in the patient system and again in the ward spreadsheet, about 45 minutes every shift.",
      terse: "Charting twice, 45 minutes.",
      terms: ["charting", "twice"],
      frequency: "daily",
      minutes: 45,
      tools: ["patient system", "spreadsheet"],
      pain: 7,
    },
    {
      name: "Phoning the lab for results",
      say: "I phone the lab for blood results several times a shift and wait on the line.",
      terse: "Phoning the lab.",
      terms: ["lab"],
      frequency: "daily",
      minutes: 20,
      tools: ["phone"],
      pain: 6,
    },
    {
      name: "Medication round documentation",
      say: "After the medication round I write what was given on paper and then enter it later.",
      terse: "Medication paperwork.",
      terms: ["medication"],
      frequency: "daily",
      minutes: 30,
      tools: ["paper"],
      pain: 5,
    },
    {
      name: "Shift handover notes",
      say: "At handover I write a summary by hand for the next nurse and read it out.",
      terse: "Handover notes by hand.",
      terms: ["handover"],
      frequency: "daily",
      minutes: 25,
      tools: ["paper"],
      pain: 4,
    },
    {
      name: "Ordering supplies",
      say: "Once a week I count the supply cupboard and order what is missing by email.",
      terse: "Weekly supply order.",
      terms: ["supply"],
      frequency: "weekly",
      minutes: 40,
      tools: ["email"],
      pain: 3,
    },
    {
      name: "Bed status updates",
      say: "Whenever a patient moves I update the bed status on the whiteboard and in the system.",
      terse: "Bed status twice.",
      terms: ["bed"],
      frequency: "daily",
      minutes: 15,
      tools: ["whiteboard", "patient system"],
      pain: 5,
    },
  ],
  flows: [
    {
      from: "lab",
      to: "nurse",
      what: "blood results by phone",
      say: "Results come from the lab by phone and I type them into the patient system by hand.",
      terms: ["results", "phone"],
    },
    {
      from: "nurse",
      to: "doctor",
      what: "questions on WhatsApp",
      say: "Quick questions to the doctors go over WhatsApp because paging is slow.",
      terms: ["whatsapp"],
    },
  ],
  pains: [
    {
      description: "Double entry causes mistakes and nobody knows which number is right",
      say: "The double entry causes mistakes and nobody knows which number is right.",
      terms: ["mistakes"],
      severity: 8,
    },
    {
      description: "Waiting for the lab delays decisions by an hour",
      say: "I wait for the lab most days, sometimes an hour, and the doctors wait for me.",
      terms: ["wait", "hour"],
      severity: 6,
    },
  ],
};

const ADMIN: DiscoveryScenario = {
  who: "it administrator",
  role: "I run IT for a hundred person company, it is me and one part time colleague.",
  daily: "Mornings are tickets and password resets, afternoons are updates and onboarding laptops.",
  tasks: [
    {
      name: "Resetting passwords",
      say: "Password resets are the bulk of tickets, about fifteen a week, each by hand in the directory.",
      terse: "Password resets, 15 a week.",
      terms: ["password"],
      frequency: "daily",
      minutes: 10,
      tools: ["directory"],
      pain: 6,
    },
    {
      name: "Onboarding laptops",
      say: "Every new hire needs a laptop set up from a checklist, which takes a whole afternoon.",
      terse: "Laptop setup, an afternoon.",
      terms: ["laptop"],
      frequency: "weekly",
      minutes: 180,
      tools: ["checklist"],
      pain: 7,
    },
    {
      name: "Patching servers",
      say: "Patching the servers is a monthly weekend job done by hand over remote shell.",
      terse: "Monthly patching by hand.",
      terms: ["patching"],
      frequency: "monthly",
      minutes: 240,
      tools: ["ssh"],
      pain: 5,
    },
    {
      name: "License true up",
      say: "Once a quarter I reconcile software licenses from three spreadsheets.",
      terse: "License reconciliation.",
      terms: ["license"],
      frequency: "rarely",
      minutes: 120,
      tools: ["spreadsheets"],
      pain: 4,
    },
    {
      name: "Backup checks",
      say: "Every morning I open the backup console to see whether last night's jobs passed.",
      terse: "Morning backup check.",
      terms: ["backup"],
      frequency: "daily",
      minutes: 15,
      tools: ["backup console"],
      pain: 3,
    },
    {
      name: "Access reviews",
      say: "Access reviews are a yearly export from five systems that I merge into one sheet.",
      terse: "Yearly access review.",
      terms: ["access"],
      frequency: "rarely",
      minutes: 300,
      tools: ["spreadsheets"],
      pain: 6,
    },
  ],
  flows: [
    {
      from: "hr",
      to: "it",
      what: "new hire details by email",
      say: "HR emails me new hire details and I copy them into the directory and the ticket.",
      terms: ["hr", "email"],
    },
    {
      from: "managers",
      to: "it",
      what: "access requests in chat",
      say: "Managers ask for access in the chat channel, so requests get lost.",
      terms: ["chat"],
    },
  ],
  pains: [
    {
      description: "Requests get lost in chat and tickets are created late",
      say: "Requests get lost in chat and I create the tickets late, so people chase me.",
      terms: ["lost"],
      severity: 7,
    },
    {
      description: "Everything depends on one person",
      say: "If I am ill nothing gets done because everything depends on me.",
      terms: ["depends"],
      severity: 8,
    },
  ],
};

function discoveryFixture(persona: Persona, scenario: DiscoveryScenario): Fixture {
  const terse = persona === "terse";
  interface Item {
    text: string;
    facts: string[];
    offTopic?: boolean;
  }
  const items: Item[] = [{ text: terse ? "Nurse, surgical ward." : scenario.role, facts: [] }];
  items.push({ text: terse ? "Rounds, charting." : scenario.daily, facts: [] });
  const goldFacts: Fixture["goldFacts"] = [];
  const pushFact = (item: Item, gold: Fixture["goldFacts"][number]): void => {
    items.push({ ...item, facts: [gold.id] });
    goldFacts.push(gold);
  };
  scenario.tasks.forEach((t, i) => {
    pushFact(
      { text: terse ? t.terse : t.say, facts: [] },
      {
        id: `T${i + 1}`,
        kind: "task",
        terms: t.terms,
        introducedAtTurn: items.length + 1,
        mustSurviveSummary: true,
        fact: {
          kind: "task",
          name: t.name,
          frequency: t.frequency,
          minutesPerOccurrence: t.minutes,
          tools: t.tools,
          painScore: t.pain,
        },
      },
    );
  });
  scenario.flows.forEach((f, i) => {
    pushFact(
      { text: terse ? `${f.what}.` : f.say, facts: [] },
      {
        id: `I${i + 1}`,
        kind: "information_flow",
        terms: f.terms,
        introducedAtTurn: items.length + 1,
        mustSurviveSummary: true,
        fact: { kind: "information_flow", from: f.from, to: f.to, what: f.what },
      },
    );
  });
  scenario.pains.forEach((p, i) => {
    pushFact(
      { text: terse ? "Mistakes, waiting." : p.say, facts: [] },
      {
        id: `P${i + 1}`,
        kind: "pain_point",
        terms: p.terms,
        introducedAtTurn: items.length + 1,
        mustSurviveSummary: true,
        fact: { kind: "pain_point", description: p.description, severity: p.severity },
      },
    );
  });
  if (persona === "off_topic") {
    const mixed: Item[] = [];
    items.forEach((it, i) => {
      mixed.push(it);
      if (i >= 1) mixed.push({ text: DRIFT[i % DRIFT.length]!, facts: [], offTopic: true });
    });
    items.length = 0;
    items.push(...mixed);
  }
  while (items.length < 60)
    items.push({ text: terse ? "Yes." : CONFIRM[items.length % CONFIRM.length]!, facts: [] });
  const turns: Fixture["turns"] = items.slice(0, 60).map((it, i) => ({
    n: i + 1,
    text: it.text,
    labels: { requirements: [], facts: it.facts, rescopes: [], offTopic: it.offTopic ?? false, sections: [] },
  }));
  // Gold turn numbers follow the final order.
  for (const g of goldFacts) g.introducedAtTurn = turns.findIndex((t) => t.labels.facts.includes(g.id)) + 1;
  const flaws: Fixture["modelBehavior"]["flaws"] = {
    "3": "marker_missing",
    "9": "malformed_json",
    "14": "truncated",
  };
  return FixtureSchema.parse({
    id: `opportunity_discovery/${persona}`,
    version: 1,
    templateKey: "opportunity_discovery",
    persona,
    turns,
    goldFacts,
    modelBehavior: { flaws },
    expect: {
      coverage: [
        { afterTurn: 12, covered: 2 },
        { afterTurn: 24, covered: 4 },
      ],
      endedWithin: 60,
    },
  });
}

function write(f: Fixture): void {
  const dir = join(ROOT, f.templateKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${f.persona}.json`), `${JSON.stringify(f, null, 2)}\n`);
}

const personas: Persona[] = [
  "cooperative",
  "terse",
  "off_topic",
  "contradictory",
  "technical",
  "nontechnical",
];
const scenarioKeys = ["charting", "roster", "library", "charting", "roster", "library"];
personas.forEach((p, i) => {
  write(requirementsFixture(p, scenarioKeys[i]!));
});
personas.forEach((p, i) => {
  write(discoveryFixture(p, i % 2 === 0 ? NURSE : ADMIN));
});

// The over-capture fixture (D-246): the cooperative interview, with a model that files each
// capability twice, files a button label as a requirement and a decision as FR-n. The gold
// requirements are the cooperative ones; what the gate measures is the list left after curation.
{
  const base = requirementsFixture("cooperative", "charting");
  const flaws: Fixture["modelBehavior"]["flaws"] = { "6": "marker_missing" };
  const kinds = ["duplicate_capture", "detail_as_fr", "decision_as_fr"] as const;
  base.goldRequirements.forEach((g, i) => {
    flaws[String(g.introducedAtTurn)] = kinds[i % kinds.length] as never;
  });
  const over: Fixture = FixtureSchema.parse({
    ...base,
    id: "requirements_discovery/over_capture",
    modelBehavior: { ...base.modelBehavior, flaws },
  });
  const dir = join(ROOT, over.templateKey);
  writeFileSync(join(dir, "over_capture.json"), `${JSON.stringify(over, null, 2)}\n`);
}
console.log(`wrote ${personas.length * 2 + 1} fixtures under ${ROOT}`);
