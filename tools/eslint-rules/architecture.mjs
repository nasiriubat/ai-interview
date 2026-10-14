// @ts-check
/**
 * The architecture fences of AGENTS.md as lint rules (engineering plan 2.5b).
 *
 *   rule 2  No model call outside ModelCaller. Provider adapters, SDK clients and the network
 *           primitives they stand on live only under packages/ai/src/providers and
 *           packages/core/src/net.
 *   rule 4  Every tenant-owned query goes through a service. A route file imports no Prisma, no
 *           tenant-scoped helper and no audit writer: it validates, guards and renders.
 *
 * Why this is one generator and not four blocks in eslint.config.js: in flat config a later block
 * that sets `no-restricted-imports` replaces an earlier one for the files it matches, options and
 * all. A block that exempts one file from one rule would silently drop the others for that file.
 * So each file gets exactly one resolved list, built here from the categories that apply to it.
 *
 * Existing violations are not hidden by weakening a rule. They are named in `ratchet.json`, one
 * entry per file and category with a reason, and a test (scripts/architecture-lint.test.mjs) fails
 * when the list grows, when an entry points at a file that no longer violates, or when a file is
 * missing. The list only ever shrinks.
 */
import { readFileSync } from "node:fs";

const ratchet = JSON.parse(readFileSync(new URL("./ratchet.json", import.meta.url), "utf8"));

/** Where adapters and network primitives belong. Nothing else may import them. */
export const NETWORK_HOMES = ["packages/ai/src/providers/**", "packages/core/src/net/**"];
/** Adapter classes may also be wired into the registry that builds them. */
export const ADAPTER_HOMES = ["packages/ai/src/**", "packages/core/src/providers/**"];

/** Where the fences apply: application source, never tests, fakes or the web app's own fetches. */
export const SOURCE_GLOBS = ["packages/*/src/**/*.ts", "apps/api/src/**/*.ts", "apps/worker/src/**/*.ts"];
const NOT_SOURCE = [
  "**/test/**",
  "**/*.test.ts",
  "**/*.e2e.test.ts",
  "packages/testing/**",
  "packages/db/seeds/**",
  "**/prisma/**",
];

/** Route files: transport only (rule 4). */
export const ROUTE_GLOBS = [
  "apps/api/src/modules/**/routes.ts",
  "apps/api/src/modules/operator/jobs.ts",
  "apps/api/src/modules/participant/voice.ts",
  "apps/api/src/modules/participant/attachments.ts",
  "apps/api/src/modules/participant/voice-live*.ts",
  "apps/api/src/modules/participant/voice-live/**/*.ts",
  "apps/api/src/modules/sessions/turn-runner.ts",
];

const MODEL_MESSAGE = "Model calls go through ModelCaller (AGENTS.md rule 2).";

const NETWORK_PATHS = [
  { name: "@anthropic-ai/sdk", message: MODEL_MESSAGE },
  { name: "openai", message: MODEL_MESSAGE },
  { name: "undici", message: "Outbound HTTP goes through EgressGuard in packages/core/src/net (S4)." },
  { name: "ws", message: "Sockets are opened through EgressGuard in packages/core/src/net (S4)." },
  { name: "node:http", message: "No raw HTTP clients outside packages/core/src/net." },
  { name: "node:https", message: "No raw HTTP clients outside packages/core/src/net." },
  { name: "http", message: "No raw HTTP clients outside packages/core/src/net." },
  { name: "https", message: "No raw HTTP clients outside packages/core/src/net." },
  { name: "node:dns", message: "Name resolution belongs to EgressGuard." },
  { name: "node:dns/promises", message: "Name resolution belongs to EgressGuard." },
  { name: "nodemailer", message: "Mail leaves through an EmailPort adapter, not a transport import." },
  { name: "pg-boss", message: "The queue is reached through JobPublisher and its adapter." },
  {
    name: "node:net",
    importNames: ["connect", "createConnection", "Socket"],
    message: "No raw sockets outside packages/core/src/net.",
  },
];

const ADAPTER_NAMES = [
  "AnthropicProvider",
  "OpenAICompatibleProvider",
  "LocalWhisperProvider",
  "ProviderRegistry",
  "createProvider",
  "openRealtimeTranscription",
  "realtimeTranscriptionUrl",
  "transcriptionSessionUpdate",
];

const ADAPTER_PATHS = [
  {
    name: "@aidp/ai",
    importNames: ADAPTER_NAMES,
    message: "Provider adapters are built by the CallerFactory and called through ModelCaller (rule 2).",
  },
];

const ADAPTER_PATTERNS = [
  {
    group: [
      "**/providers/anthropic*",
      "**/providers/openai-*",
      "**/providers/local-whisper*",
      "**/providers/realtime-socket*",
      "**/providers/registry*",
    ],
    message: "Provider adapters are built by the CallerFactory and called through ModelCaller (rule 2).",
  },
];

const PRISMA_PATHS = [
  {
    name: "@prisma/client",
    message: "A route file holds no Prisma: call a service whose first parameter is companyId (rule 4).",
  },
  {
    name: "@aidp/db",
    importNames: [
      "PrismaClient",
      "prisma",
      "forCompany",
      "tenantBatch",
      "tenantTransaction",
      "withSystemTenant",
      "enterSystemTenant",
      "containsInsensitive",
      "escapeLike",
      "SYSTEM_TENANT",
    ],
    message: "A route file holds no Prisma: call a service whose first parameter is companyId (rule 4).",
  },
];

const PRISMA_PATTERNS = [
  {
    group: ["**/lib/audit", "**/lib/audit.js"],
    message: "Audit rows are written through ctx.services.audit, never with a database client (rule 4).",
  },
];

/** Global `fetch` is a network client too: adapters take an injected one from EgressGuard. */
const FETCH_SELECTORS = [
  {
    selector: "CallExpression[callee.name='fetch']",
    message: "Do not call the global fetch; use the EgressGuard-provided fetch (rule 2, S4).",
  },
  {
    selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
    message: "Do not reach for globalThis.fetch; use the EgressGuard-provided fetch (rule 2, S4).",
  },
  {
    selector: "LogicalExpression[operator='??'] > Identifier.right[name='fetch']",
    message: "Do not default to the global fetch; require an injected one (rule 2, S4).",
  },
  {
    selector: "AssignmentPattern > Identifier.right[name='fetch']",
    message: "Do not default to the global fetch; require an injected one (rule 2, S4).",
  },
];

const PROMPT_SELECTOR = {
  selector: "Literal[value=/^[a-z_]+@\\d+$/]",
  message: "Do not write a prompt version by hand; use promptVersionTag(prompt) (D-101).",
};

/** @typedef {"network" | "adapters" | "fetch" | "prisma"} Category */

/**
 * The resolved rule options for a file that is subject to `categories`.
 * @param {Category[]} categories
 */
export function rulesFor(categories) {
  const has = (/** @type {Category} */ c) => categories.includes(c);
  const paths = [
    ...(has("network") ? NETWORK_PATHS : []),
    ...(has("adapters") ? ADAPTER_PATHS : []),
    ...(has("prisma") ? PRISMA_PATHS : []),
  ];
  const patterns = [...(has("adapters") ? ADAPTER_PATTERNS : []), ...(has("prisma") ? PRISMA_PATTERNS : [])];
  return {
    "no-restricted-imports": ["error", { paths, patterns }],
    "no-restricted-syntax": ["error", PROMPT_SELECTOR, ...(has("fetch") ? FETCH_SELECTORS : [])],
  };
}

/** Ratchet entries as `{ file, category, reason }`, read once. */
export const RATCHET = /** @type {{ file: string; category: Category; reason: string }[]} */ (
  ratchet.exemptions
);

/**
 * The config blocks, in the order flat config needs (later wins).
 * @param {{ ignoreRatchet?: boolean }} [options] `ignoreRatchet` is for the test that proves an
 *   entry is still needed: it lints a file as if it were not listed.
 */
export function architectureBlocks(options = {}) {
  const exemptFrom = (/** @type {string} */ file) =>
    options.ignoreRatchet ? [] : RATCHET.filter((e) => e.file === file).map((e) => e.category);

  // 1. Everything that is application source: all four fences, minus the homes.
  const blocks = [
    {
      name: "architecture/source",
      files: SOURCE_GLOBS,
      ignores: [...NOT_SOURCE, ...NETWORK_HOMES],
      rules: rulesFor(["network", "adapters", "fetch"]),
    },
    // 2. The providers directory is both a network home and an adapter home: free to do both.
    {
      name: "architecture/providers-home",
      files: ["packages/ai/src/providers/**/*.ts"],
      ignores: NOT_SOURCE,
      rules: rulesFor([]),
    },
    // 3. core/net is the network home but is not an adapter home: it may not build adapters.
    {
      name: "architecture/net-home",
      files: ["packages/core/src/net/**/*.ts"],
      ignores: NOT_SOURCE,
      rules: rulesFor(["adapters"]),
    },
    // 4. The rest of the adapter homes (the engine, the caller factory) build adapters but may not
    //    open connections themselves.
    {
      name: "architecture/adapter-homes",
      files: ADAPTER_HOMES.map((g) => `${g}/*.ts`),
      ignores: [...NOT_SOURCE, ...NETWORK_HOMES],
      rules: rulesFor(["network", "fetch"]),
    },
    // 5. Route files: transport only.
    {
      name: "architecture/routes",
      files: ROUTE_GLOBS,
      ignores: NOT_SOURCE,
      rules: rulesFor(["network", "adapters", "fetch", "prisma"]),
    },
  ];

  // 5. One block per ratcheted file, with the categories it is allowed to keep violating removed.
  const files = [...new Set(RATCHET.map((e) => e.file))];
  for (const file of files) {
    const exempt = exemptFrom(file);
    if (exempt.length === 0) continue;
    const isRoute = ROUTE_GLOBS.some((g) => matchesGlob(file, g));
    /** @type {Category[]} */
    const all = isRoute ? ["network", "adapters", "fetch", "prisma"] : ["network", "adapters", "fetch"];
    const inAdapterHome = ADAPTER_HOMES.some((g) => matchesGlob(file, g));
    const categories = all.filter((c) => !exempt.includes(c) && !(inAdapterHome && c === "adapters"));
    blocks.push({
      name: `architecture/ratchet:${file}`,
      files: [file],
      ignores: [],
      rules: rulesFor(categories),
    });
  }
  return blocks;
}

/**
 * A minimal glob match for the patterns used above (`**` and `*`), so the config does not need a
 * dependency just to decide which categories a ratcheted file is still subject to.
 * @param {string} file
 * @param {string} glob
 */
export function matchesGlob(file, glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${re}$`).test(file);
}
