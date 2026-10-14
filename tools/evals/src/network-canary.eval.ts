import net from "node:net";
import { describe, expect, it } from "vitest";

/**
 * Canary for AGENTS.md rule 5: tests never hit the network.
 *
 * Every package loads `packages/testing/src/network-guard.ts` as a Vitest setup file. If someone
 * drops it from this package's config, or a refactor stops it patching `fetch` and sockets, this
 * test goes red instead of the suite quietly gaining the ability to call the internet. Self
 * contained on purpose: it must not depend on the thing it is checking.
 */
describe("network canary", () => {
  it("refuses fetch to a public host", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/network access in tests/);
  });

  it("refuses a raw socket to a public host", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: "example.com", port: 443 });
      socket.once("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", (err) => {
        resolve(err.message);
      });
    });
    expect(outcome).toMatch(/network access in tests/);
  });
});
