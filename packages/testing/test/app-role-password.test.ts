import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_ROLE_TEST_PASSWORD, APP_ROLE_TEST_USER, appRoleUrl } from "../src/app-role.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (name.endsWith(".test.ts") || name.endsWith("helpers.ts")) out.push(full);
  }
  return out;
}

describe("the app_api test password", () => {
  it("is never logged in or re-passworded by a suite: tests connect as their own role", () => {
    const offenders: string[] = [];
    for (const top of ["apps", "packages", "evals", "scripts", "tools"]) {
      let files: string[] = [];
      try {
        files = testFiles(join(root, top));
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.endsWith("app-role-password.test.ts")) continue;
        if (readFileSync(file, "utf8").includes("ALTER ROLE app_api WITH LOGIN PASSWORD")) {
          offenders.push(relative(root, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("builds the runtime role url from the owner url", () => {
    const url = new URL(appRoleUrl("postgresql://app:app@localhost:5432/db"));
    expect(url.username).toBe(APP_ROLE_TEST_USER);
    expect(url.password).toBe(APP_ROLE_TEST_PASSWORD);
    expect(url.pathname).toBe("/db");
  });
});
