import { describe, expect, it } from "vitest";
import { currentTenant, withSystemTenant, withTenant } from "../src/tenancy.js";

/** A thenable that, like a Prisma query, only does its work when someone calls `then`. */
function lazyQuery(): PromiseLike<string | null> {
  return {
    then(resolve, reject) {
      return Promise.resolve(currentTenant()).then(resolve, reject);
    },
  };
}

describe("tenant context with lazy queries", () => {
  it("runs a lazy query returned from withSystemTenant inside the system context", async () => {
    await expect(withSystemTenant(() => lazyQuery() as Promise<string | null>)).resolves.toBe("system");
  });
  it("runs a lazy query returned from withTenant inside that tenant's context", async () => {
    await expect(withTenant("c1", () => lazyQuery() as Promise<string | null>)).resolves.toBe("c1");
  });
});
