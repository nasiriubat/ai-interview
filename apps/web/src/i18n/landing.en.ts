/**
 * The public landing page (`/`), English. The type source for `landing.fi.ts`.
 *
 * Every sentence here is a claim about the product and is checked against the code in
 * `docs/team/claims-2026-10.md` (the ids in the comments are its rows). A sentence that is not
 * `Built` there does not belong on this page. Numbers that come from a test run say so.
 *
 * The product name is not in this file: the page reads it from `app.name`, so a rename is one edit
 * in `en.ts` and `fi.ts` (positioning.md section 4, D-270).
 *
 * Arrays are used on purpose (steps, rows, questions); the page reads this object directly through
 * `stringsFor(locale)` rather than through the `t` proxy, which is built for leaves.
 */
export const landingEn = {
  meta: {
    /** After the product name: "<name>: <titleTail>". */
    titleTail: "Understand the problem before deciding what to build",
    description:
      "Structured interviews with your employees become a ranked map of where work gets stuck. Any opportunity or idea becomes a versioned specification your developers or your coding agent can build from.",
  },
  nav: {
    label: "On this page",
    paths: "Two interviews",
    how: "How it works",
    results: "Results",
    chatbot: "Why not a chatbot",
    trust: "Trust",
    faq: "Questions",
  },
  header: {
    signIn: "Sign in",
    dashboard: "Go to the overview",
    menu: "Menu",
    closeMenu: "Close menu",
    menuTitle: "Menu",
  },
  hero: {
    eyebrow: "For organizations that want to know before they build",
    title: "Understand the problem before deciding what to build.",
    lead: "Structured interviews with your employees become a ranked map of where work gets stuck and what, if anything, should change. Any opportunity or idea then becomes a specification your developers or your coding agent can build from. It is built to run on a server you operate, under rules you set.",
    requestWorkspace: "Request a workspace",
    signIn: "Sign in",
    dashboard: "Go to the overview",
    noContact:
      "Workspaces are created by the operator of this platform. Ask them, or sign in if you have one.",
    visualAlt:
      "The results page of a campaign: counts of interviews, extracted items and groups, then opportunities ranked by score with the scoring weights beside them.",
    phoneAlt: "The interview on a phone: topic chips above, a participant's answer, the next question below.",
    small: [
      "No account for participants",
      "Built to run on one server you operate",
      "Every model call recorded with its cost",
    ],
  },
  participant: {
    heading: "Were you sent an interview link?",
    body: "You do not need an account, and nothing on this page. Open the link from your invitation. It tells you who is asking and why, what is kept and how to delete it.",
    points: [
      "Type, tap options or, where your organization has switched it on, speak.",
      "Pause whenever you like and come back to the same link.",
      "In a report, a quote appears only when enough people said something similar: at least three by default.",
    ],
  },
  paths: {
    heading: "Two kinds of interview, with a bridge between them",
    intro: "Use either one alone. Or start with your people and carry what they said into the build.",
    discovery: {
      kicker: "Discovery interviews",
      audience: "For HR, operations and transformation leads",
      title: "Find out how work is really done",
      paragraphs: [
        "Invite your people by link. Each person has a conversation, by text, options or voice, about how their work is actually done: role, daily activities, repetitive tasks, tools, manual steps, hand-offs, bottlenecks and problems. The interviewer asks one question at a time, goes one level deeper when a process comes up, and is instructed never to ask where AI should be used.",
        "When enough people have answered, the interviews are analyzed together. Similar tasks and problems are grouped, counted and scored on seven factors: impact, people affected, frequency, simplicity, data availability, risk and AI fit. Each opportunity is classified as AI, automation, software, process change or no change recommended.",
        "You receive a report: executive summary, work map, department comparison, opportunities by solution class, quick wins and strategic bets, where AI is not the answer, and next steps.",
      ],
    },
    bridge: {
      kicker: "The bridge",
      title: "From an opportunity to a requirements interview",
      body: "Select an opportunity and start a requirements interview from it. What the first round learned is carried over as a starting brief, so the second interview asks only what is still missing.",
    },
    requirements: {
      kicker: "Requirements interviews",
      audience: "For product owners, CTOs, founders and consultants",
      title: "Turn an idea into something a developer can build",
      paragraphs: [
        "Start from a sentence or from a discovered opportunity, and attach documents as you go. Say whether you are technical or not. The interviewer first settles the context: hosting, existing systems, who builds, team skills, timeline, budget, users at launch and compliance. Then it works through users, stories, requirements, rules, data, integrations, security, the admin surface, MVP, future scope and phases, one decision per question, each with a reason and a default.",
        "Every five turns a separate pass checks the specification for ambiguity, contradictions, missing decisions and unnecessary complexity, and raises one finding at a time. Before it finishes, it walks your MVP list and asks of each item what breaks if version one ships without it.",
        "You receive a versioned specification: a readable document, a machine-readable file, and a bundle for Claude Code or Codex with context, a phase plan and a task file per phase with acceptance criteria. Reopen it later and see what changed between versions.",
      ],
    },
  },
  how: {
    heading: "How it works",
    discovery: {
      title: "Discovery interviews",
      visualAlt: "An interview on a phone, with topic chips, the participant's answer and the next question.",
      steps: [
        {
          title: "Create a campaign from a template",
          body: "Choose named, anonymous or the participant's own choice. Set the consent text and who may read transcripts. Preview the interview yourself before you send it.",
        },
        {
          title: "Share one link, or send invitations",
          body: "Participants can confirm their email once so that each person answers once. In anonymous campaigns the email is never stored with the answers.",
        },
        {
          title: "People answer",
          body: "On a phone or in a browser, with no app and no account. Type, tap options, record an answer, or speak where voice is set up. Attach a document if it helps. Pause and come back; answers are saved as they are given.",
        },
        {
          title: "Read the report",
          body: "Analysis runs when the completion threshold is reached or when you start it. Merge, split or rename groups, adjust the weights, hide sections, download the report as Markdown or PDF, and take the opportunities worth building into a requirements interview.",
        },
      ],
    },
    requirements: {
      title: "Requirements interviews",
      visualAlt:
        "A requirements interview: the conversation on the left, the specification being built on the right.",
      steps: [
        {
          title: "Describe the idea",
          body: "A sentence is enough. Attach what you have, or start from a discovered opportunity and skip what is already known.",
        },
        {
          title: "Settle the context first",
          body: "Eight questions about hosting, builders, skills, timeline, budget, scale and compliance shape every later question and default.",
        },
        {
          title: "Decide, one question at a time",
          body: "Each question says why it matters and offers a default you can accept in a word. Findings are raised as they appear; the interviewer pushes back once, then records your choice.",
        },
        {
          title: "Take the specification",
          body: "Download the specification and the agent bundle. Every version is kept; reopening a session creates the next version and shows what changed.",
        },
      ],
    },
  },
  gallery: {
    heading: "What you get",
    intro: "Screens from the product, taken from a run with invented colleagues.",
    items: [
      {
        title: "Opportunities, ranked and classified",
        body: "Each opportunity is scored on seven factors and classified as AI, automation, software, process change or no change recommended. Reweight the factors and the list re-ranks at once.",
        alt: "The opportunity list grouped by solution class, each with a score bar, seven factor bars and actions.",
      },
      {
        title: "Evidence behind every score",
        body: "Open an opportunity to see the rationale for each factor and the evidence that supports it. A quote appears only when enough people said something similar.",
        alt: "An opportunity opened to show its seven factors with a rationale each, and anonymized evidence quotes below.",
      },
      {
        title: "A versioned specification",
        body: "Numbered requirements marked MVP or future, phases and open findings, downloadable as Markdown, JSON and a bundle for your coding agent. Every version is kept and can be compared.",
        alt: "A specification version with counts of sections, requirements, MVP items and phases, and download buttons.",
      },
      {
        title: "Diagrams in the specification",
        body: "Sequence diagrams are part of the specification and can be edited.",
        alt: "A sequence diagram of a visitor check-in flow between visitor, web app, spreadsheet and reception.",
      },
    ],
  },
  chatbot: {
    heading: "Why not just use a chatbot?",
    intro: "You can ask a chatbot to interview your team. Here is what you get instead.",
    tableCaption: "A chat window compared with this platform",
    columnChat: "With a chat window",
    columnHere: "Here",
    rows: [
      {
        chat: "One conversation at a time, each a little different",
        here: "The same interview for every participant, from a template whose version is fixed for the campaign",
      },
      {
        chat: "A transcript per person for someone to read",
        here: "Extracted items on a fixed schema, grouped and counted across the whole campaign",
      },
      {
        chat: "Anonymity as a promise",
        here: "A quote, role or department appears only when at least three people are behind it. The rule is a setting and is printed in the report",
      },
      {
        chat: "A model that wants to help build something",
        here: "An analysis that may conclude no change is recommended, and says why",
      },
      {
        chat: "A document",
        here: "A versioned specification with numbered requirements, acceptance criteria, phased tasks and a diff between versions",
      },
      {
        chat: "Whatever the vendor's retention policy says",
        here: "A server you operate, model providers you choose, a ledger of every call, an audit log of administrator actions, deletion on request and automatic retention limits",
      },
    ],
    justAsWellHeading: "What a chatbot does just as well",
    justAsWell:
      "A first draft for one person with one idea, and good prose. The sentences in a report come from the same kind of model; the difference is what goes in (structured items, counts, the anonymity rule) and what is done with what comes out (checks, versions, diffs). If a draft for tonight is what you need, use a chatbot. Come back when the idea has to survive thirty colleagues or one coding agent.",
  },
  trust: {
    heading: "What you can rely on",
    intro: "Each of these is a behavior of the software, not a promise in a policy.",
    items: [
      {
        title: "Privacy",
        body: "Participants never need an account. The consent text is yours to write, and the version each person agreed to is recorded. Who may open raw transcripts is a setting; by default administrators can read a transcript only when the participant chose to be identified and agreed.",
      },
      {
        title: "Anonymity",
        body: "In anonymous campaigns the email is used to make sure each person answers once, and only a salted hash of it is kept on the campaign, not linked to the answers. A quote, a role or a department appears in a report only when at least three participants are behind it. Three is the default; your organization sets the number.",
      },
      {
        title: "Hosting and providers",
        body: "The platform is built to run on a single server that you operate, in the region you choose, with the API kept off the public internet. Model calls go only to the providers your organization configures, for each task: a hosted service, or an OpenAI-compatible endpoint you run yourself. Recordings can be transcribed on the same server. Some hosted providers process data outside the EU, and the platform lists each provider and where it processes data.",
      },
      {
        title: "Your data",
        body: "A participant can delete their answers, recordings and files from the interview menu, and the name and email they gave are deleted with them. They can also download their own data. Totals that were already combined with other answers remain and cannot be traced to the person. Interview data is deleted automatically after the retention period you set, 24 months by default. Administrator actions go to an append-only audit log.",
      },
      {
        title: "Cost you can see",
        body: "Every model call is recorded with its task, provider, model, tokens and cost. Budgets exist for the organization, each campaign and each interview. Administrators are warned before a budget is used up, and an interview under a spent budget pauses visibly. Spend is shown per campaign and per task.",
      },
    ],
  },
  audience: {
    heading: "Who it is for",
    items: [
      {
        title: "HR and operations leads",
        body: "You need to know where time goes before the next tooling decision, and you want people to be able to speak frankly.",
      },
      {
        title: "CTOs and heads of digital",
        body: "You are asked what to do with AI, and you want an answer that may include nothing.",
      },
      {
        title: "Consultancies",
        body: "You run discovery for clients. Each client can be its own organization with its own templates, model providers, budgets and reports.",
      },
      {
        title: "Product owners",
        body: "You have an idea and a developer waiting, and you want the questions asked before the sprint rather than during it.",
      },
      {
        title: "Developers and coding agents",
        body: "You would rather receive numbered requirements, acceptance criteria and a phase plan than a slide deck.",
      },
    ],
  },
  faq: {
    heading: "Questions",
    items: [
      {
        q: "Can't I just use ChatGPT for this?",
        a: "For one person drafting one idea, yes, and the draft will be decent. This is for when many people have to be interviewed the same way, when nobody's words may be exposed, when the answer may be do not build this, and when the result has to be a versioned specification that a developer or an agent can work from. The comparison above is the honest version.",
      },
      {
        q: "Is it anonymous?",
        a: "It can be. The campaign owner chooses named, anonymous, or lets each participant choose. In anonymous mode the email is used to confirm one answer per person and only a salted hash stays on the campaign, not linked to the interview. In a report, quotes and breakdowns appear only when at least three people are behind them.",
      },
      {
        q: "Where is my data?",
        a: "On the server of the organization that runs the platform; the reference deployment is a single EU server. Interview text goes only to the model providers that organization has configured, which can be hosted services or an endpoint it runs itself. Some hosted providers process data outside the EU, so the provider list matters. Recordings can be transcribed on the same server when local transcription is switched on.",
      },
      {
        q: "Does the AI decide what we should build?",
        a: "No. The discovery interviewer is instructed never to ask where AI should be used and never to suggest solutions. The analysis scores each opportunity and may classify it as no change recommended, with the reason. The requirements interview offers defaults; you decide, and your decision is recorded.",
      },
      {
        q: "What do developers receive?",
        a: "A specification as Markdown and JSON with numbered requirements, each marked MVP or future with acceptance criteria; business rules; technical decisions; data entities; integrations; the admin surface; open questions with the default taken; and implementation phases. Plus a bundle for Claude Code or Codex with an agent guide, a phase plan and a task file per phase. Versions are kept and compared.",
      },
      {
        q: "What does it cost?",
        a: "Two parts: the platform, which you host or have hosted for you, and the model usage. Every call is recorded with its cost, and you set budgets for the organization, each campaign and each interview. In an internal test with eight simulated interviewees and low-cost models, an interview cost 1.4 to 2.2 cents in model usage. That is a test figure, not a quote; your models and your interviews will differ.",
      },
      {
        q: "How long does an interview take?",
        a: "It ends when the topics are covered, when the participant says they are done, or at the turn limit, which is 60 turns for the discovery template. In our test runs, interviews took 20 to 24 turns. Participants can pause and return to the same link.",
      },
      {
        q: "Can we change the questions?",
        a: "Yes. An interview is a template: topics with a done-when criterion, instructions, follow-up limits, answer options, privacy mode and outputs. Copy a built-in template, edit it, preview it as a throwaway interview, and publish a version. A campaign keeps the version it started with.",
      },
      {
        q: "What if someone gives one-word answers or goes off topic?",
        a: "The interviewer switches to concrete prompts and answer options, and after three minimal answers shortens the interview to the essential topics. Off-topic remarks are acknowledged and parked. If someone seems distressed, the interviewer stops probing and flags the interview for the organizer, without recording a judgment about the person.",
      },
      {
        q: "Who can read the transcripts?",
        a: "A setting. By default, administrators, and only when the participant chose to be identified and agreed. Members see combined results. Participants see their own summary at the end and can correct it.",
      },
    ],
  },
  cta: {
    heading: "Run a first campaign with a few colleagues",
    body: "Ask for a workspace, start from the built-in discovery template, preview it on yourself and invite a handful of colleagues. The first report tells you whether a larger round is worth it.",
    request: "Request a workspace",
    signIn: "Sign in",
    dashboard: "Go to the overview",
    consultancy:
      "Running discovery for clients? Each client can be its own organization with its own templates, model providers, budgets and reports. Ask about operator access.",
  },
  footer: {
    navLabel: "Footer",
    product: "Product",
    access: "Access",
    trust: "Trust and contact",
    privacy: "Privacy and anonymity",
    contact: "Contact",
    security: "Report a vulnerability (security.txt)",
    language: "Language",
    note: "This page runs no tracking and makes no requests to other sites. Your language and appearance choices stay in your browser.",
    signIn: "Sign in",
  },
  mailto: {
    subject: "Workspace request",
    body: "Hello,\n\nI would like to request a workspace.\n\nOrganization:\nWhat we want to find out:\n",
  },
};

export type LandingStrings = typeof landingEn;
