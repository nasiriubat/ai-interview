/**
 * The architecture fences (AGENTS.md rules 2 and 4) have to be proven to fire, not assumed to:
 * a lint rule with a wrong glob passes silently. Each case lints a fixture under a pretend path
 * with only the architecture blocks loaded, so no tsconfig or type information is involved.
 *
 * The ratchet is checked here too. `eslint-rules/ratchet.json` may only shrink, and each entry
 * must still be needed: an entry whose file no longer breaks its fence has to be deleted, which is
 * how the list gets shorter instead of rotting.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { architectureBlocks, matchesGlob, RATCHET } from "../eslint-rules/architecture.mjs";

const ratchetFile = JSON.parse(
  readFileSync(new URL("../eslint-rules/ratchet.json", import.meta.url), "utf8"),
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The most entries the ratchet may hold. Lower it when entries are fixed; never raise it. */
const RATCHET_CEILING = 6;

function lint(code, filename, options) {
  const linter = new Linter({ cwd: root, configType: "flat" });
  const config = [
    { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
    ...architectureBlocks(options),
  ];
  return linter.verify(code, config, { filename });
}

const ids = (messages) => messages.map((m) => m.ruleId);

describe("rule 4: a route file touches no Prisma", () => {
  const routes = "apps/api/src/modules/widgets/routes.ts";

  it("refuses @prisma/client, value or type", () => {
    assert.deepEqual(ids(lint('import type { Prisma } from "@prisma/client";', routes)), [
      "no-restricted-imports",
    ]);
    assert.deepEqual(ids(lint('import { PrismaClient } from "@prisma/client";', routes)), [
      "no-restricted-imports",
    ]);
  });

  it("refuses the tenant helpers and the audit writer", () => {
    assert.equal(lint('import { tenantBatch } from "@aidp/db";', routes).length, 1);
    assert.equal(lint('import { withSystemTenant } from "@aidp/db";', routes).length, 1);
    assert.equal(lint('import { audit } from "../../lib/audit.js";', routes).length, 1);
  });

  it("keeps the other route fences on the same file (flat config does not merge options)", () => {
    assert.equal(lint('import nodemailer from "nodemailer";', routes).length, 1);
    assert.equal(lint('import { AnthropicProvider } from "@aidp/ai";', routes).length, 1);
  });

  it("covers the route-like files that are not named routes.ts", () => {
    for (const file of [
      "apps/api/src/modules/participant/voice.ts",
      "apps/api/src/modules/participant/attachments.ts",
      "apps/api/src/modules/sessions/turn-runner.ts",
      "apps/api/src/modules/operator/jobs.ts",
    ]) {
      assert.equal(lint('import type { Prisma } from "@prisma/client";', file).length, 1, file);
    }
  });

  it("leaves services alone: that is where Prisma belongs", () => {
    const service = "apps/api/src/modules/widgets/service.ts";
    assert.deepEqual(lint('import type { PrismaClient } from "@prisma/client";', service), []);
    assert.deepEqual(lint('import { tenantBatch } from "@aidp/db";', service), []);
  });

  it("allows tenant plumbing that is not a query (withTenant)", () => {
    assert.deepEqual(lint('import { withTenant } from "@aidp/db";', routes), []);
  });
});

describe("rule 2: provider adapters and network clients stay in their homes", () => {
  it("refuses an SDK or HTTP client anywhere else", () => {
    for (const mod of [
      "@anthropic-ai/sdk",
      "openai",
      "undici",
      "ws",
      "node:https",
      "nodemailer",
      "pg-boss",
    ]) {
      const found = lint(`import x from "${mod}";\nvoid x;`, "packages/core/src/sessions/engine-factory.ts");
      assert.deepEqual(ids(found), ["no-restricted-imports"], mod);
    }
  });

  it("refuses an adapter class from @aidp/ai outside the adapter homes", () => {
    const found = lint('import { OpenAICompatibleProvider } from "@aidp/ai";', "apps/worker/src/handlers.ts");
    assert.deepEqual(ids(found), ["no-restricted-imports"]);
  });

  it("refuses a relative import of an adapter file", () => {
    const found = lint('import { x } from "../../ai/src/providers/anthropic.js";', "apps/api/src/lib/y.ts");
    assert.deepEqual(ids(found), ["no-restricted-imports"]);
  });

  it("refuses the global fetch, called or used as a default", () => {
    const file = "packages/core/src/sessions/engine-factory.ts";
    assert.deepEqual(ids(lint('await fetch("https://example.com");', file)), ["no-restricted-syntax"]);
    assert.deepEqual(ids(lint("const f = opts.fetch ?? fetch;", file)), ["no-restricted-syntax"]);
    assert.deepEqual(ids(lint("class A { constructor(f = fetch) { void f; } }", file)), [
      "no-restricted-syntax",
    ]);
    assert.deepEqual(ids(lint("const f = globalThis.fetch;", file)), ["no-restricted-syntax"]);
  });

  it("does not mind `typeof fetch` in a type position", () => {
    assert.deepEqual(
      lint(
        "export type F = typeof fetch; export const g: F | undefined = undefined;",
        "packages/core/src/a.ts",
      ),
      [],
    );
  });

  it("lets the homes do their job", () => {
    assert.deepEqual(
      lint(
        'import Anthropic from "@anthropic-ai/sdk";\nvoid Anthropic;',
        "packages/ai/src/providers/anthropic.ts",
      ),
      [],
    );
    assert.deepEqual(
      lint('import { Agent } from "undici";\nvoid Agent;', "packages/core/src/net/egress.ts"),
      [],
    );
    assert.deepEqual(
      lint(
        'import { createProvider } from "@aidp/ai";\nvoid createProvider;',
        "packages/core/src/providers/caller-factory.ts",
      ),
      [],
    );
  });

  it("does not apply to tests, which stand up fake servers", () => {
    assert.deepEqual(
      lint('import { createServer } from "node:http";\nvoid createServer;', "apps/api/test/helpers.ts"),
      [],
    );
    assert.deepEqual(lint('import ws from "ws";\nvoid ws;', "packages/ai/test/fake-realtime.test.ts"), []);
  });

  it("still enforces the prompt-version rule alongside", () => {
    const found = lint('const v = "extraction@1";\nvoid v;', "packages/core/src/x.ts");
    assert.deepEqual(ids(found), ["no-restricted-syntax"]);
  });
});

describe("the ratchet only shrinks", () => {
  it("never holds more entries than its ceiling", () => {
    assert.ok(
      RATCHET.length <= RATCHET_CEILING,
      `eslint-rules/ratchet.json has ${RATCHET.length} entries; the ceiling is ${RATCHET_CEILING}. Fix the file instead of adding an entry.`,
    );
  });

  it("gives every entry a file, a category and a reason", () => {
    for (const e of RATCHET) {
      assert.ok(["network", "adapters", "fetch", "prisma"].includes(e.category), e.file);
      assert.ok(e.reason.length > 30, `${e.file}: say why`);
      assert.ok(existsSync(resolve(root, e.file)), `${e.file} no longer exists: delete its entry`);
    }
  });

  it("keeps an entry only while its file still breaks that fence", () => {
    const rule = {
      network: "no-restricted-imports",
      adapters: "no-restricted-imports",
      fetch: "no-restricted-syntax",
      prisma: "no-restricted-imports",
    };
    for (const e of RATCHET) {
      const code = readFileSync(resolve(root, e.file), "utf8");
      const found = lint(code, e.file, { ignoreRatchet: true }).filter((m) => m.ruleId === rule[e.category]);
      assert.ok(
        found.length > 0,
        `${e.file} no longer breaks the ${e.category} fence: delete its entry from ratchet.json`,
      );
    }
  });

  it("matches globs the way the config assumes", () => {
    assert.ok(matchesGlob("apps/api/src/modules/a/routes.ts", "apps/api/src/modules/**/routes.ts"));
    assert.ok(!matchesGlob("apps/api/src/modules/a/service.ts", "apps/api/src/modules/**/routes.ts"));
    assert.ok(matchesGlob("packages/ai/src/x/y.ts", "packages/ai/src/**/*.ts"));
  });
});

describe("double casts are rationed", () => {
  const CAST = /as unknown as|as PrismaClient\b/;
  const files = execFileSync("git", ["ls-files", "--", "*.ts", "*.tsx"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => existsSync(resolve(root, f)));
  const isTest = (f) => /(^|\/)(test|evals|testing)\//.test(f) || /\.test\.tsx?$/.test(f);
  const count = (f) =>
    readFileSync(resolve(root, f), "utf8")
      .split("\n")
      .filter((line) => CAST.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)).length;

  it("allows application source only the named files, each within its count", () => {
    const allowed = new Map(ratchetFile.casts.exemptions.map((e) => [e.file, e.max]));
    assert.ok(allowed.size < 5, "the allow-list is for a handful of files");
    for (const e of ratchetFile.casts.exemptions) assert.ok(e.reason.length > 30, `${e.file}: say why`);
    const over = [];
    for (const f of files.filter((f) => /^(apps|packages)\/[^/]+\/src\//.test(f) && !isTest(f))) {
      const n = count(f);
      if (n > (allowed.get(f) ?? 0)) over.push(`${f}: ${n} (allowed ${allowed.get(f) ?? 0})`);
    }
    assert.deepEqual(over, [], "replace the cast with a typed alternative, or justify it in ratchet.json");
  });

  it("keeps the count in tests and fakes at or under its ceiling", () => {
    const total = files.filter(isTest).reduce((n, f) => n + count(f), 0);
    assert.ok(
      total <= ratchetFile.casts.testCeiling,
      `${total} double casts in tests; the ceiling is ${ratchetFile.casts.testCeiling}`,
    );
  });

  it("drops an exemption when its file no longer needs it", () => {
    for (const e of ratchetFile.casts.exemptions) {
      assert.ok(count(e.file) > 0, `${e.file} has no double cast left: delete its entry`);
    }
  });
});
