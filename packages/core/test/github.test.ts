import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubApi, GitHubError, MemoryGitHub } from "../src/requirements/github.js";

interface FakeState {
  refs: Record<string, string>;
  commits: Record<string, { tree: string; parents: string[]; message: string }>;
  trees: Record<string, { base?: string; entries: { path: string; sha: string }[] }>;
  blobs: Record<string, string>;
  requests: { method: string; url: string; auth: string | undefined; body: unknown }[];
}

/** Enough of the Git Data API for one push: refs, commits, blobs, trees. */
function fakeGitHub(): Promise<{ server: Server; url: string; state: FakeState }> {
  const state: FakeState = {
    refs: { main: "c0" },
    commits: { c0: { tree: "t0", parents: [], message: "init" } },
    trees: { t0: { entries: [] } },
    blobs: {},
    requests: [],
  };
  let counter = 0;
  const id = (prefix: string): string => `${prefix}${++counter}`;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body: unknown = raw ? JSON.parse(raw) : undefined;
        const url = req.url ?? "";
        const method = req.method ?? "GET";
        state.requests.push({ method, url, auth: req.headers.authorization, body });
        const json = (status: number, data: unknown): void => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(data));
        };
        if (req.headers.authorization !== "Bearer ghp_test") {
          json(401, { message: "Bad credentials" });
          return;
        }
        let m: RegExpExecArray | null;
        if (method === "GET" && url === "/repos/acme/app") {
          json(200, { default_branch: "main" });
          return;
        }
        if (method === "GET" && (m = /^\/repos\/acme\/app\/git\/ref\/heads\/(.+)$/.exec(url))) {
          const sha = state.refs[m[1] ?? ""];
          sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
          return;
        }
        if (method === "POST" && url === "/repos/acme/app/git/refs") {
          const b = body as { ref: string; sha: string };
          state.refs[b.ref.replace("refs/heads/", "")] = b.sha;
          json(201, { ref: b.ref, object: { sha: b.sha } });
          return;
        }
        if (method === "GET" && (m = /^\/repos\/acme\/app\/git\/commits\/(.+)$/.exec(url))) {
          const c = state.commits[m[1] ?? ""];
          c ? json(200, { sha: m[1], tree: { sha: c.tree } }) : json(404, { message: "Not Found" });
          return;
        }
        if (method === "POST" && url === "/repos/acme/app/git/blobs") {
          const b = body as { content: string; encoding: string };
          const sha = id("b");
          state.blobs[sha] = Buffer.from(b.content, "base64").toString("utf8");
          json(201, { sha });
          return;
        }
        if (method === "POST" && url === "/repos/acme/app/git/trees") {
          const b = body as { base_tree?: string; tree: { path: string; sha: string }[] };
          const sha = id("t");
          state.trees[sha] = { ...(b.base_tree ? { base: b.base_tree } : {}), entries: b.tree };
          json(201, { sha });
          return;
        }
        if (method === "POST" && url === "/repos/acme/app/git/commits") {
          const b = body as { message: string; tree: string; parents: string[] };
          const sha = id("c");
          state.commits[sha] = { tree: b.tree, parents: b.parents, message: b.message };
          json(201, { sha, html_url: `https://github.com/acme/app/commit/${sha}` });
          return;
        }
        if (method === "PATCH" && (m = /^\/repos\/acme\/app\/git\/refs\/heads\/(.+)$/.exec(url))) {
          const b = body as { sha: string };
          state.refs[m[1] ?? ""] = b.sha;
          json(200, { object: { sha: b.sha } });
          return;
        }
        json(404, { message: "Not Found" });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, state });
    });
  });
}

describe("GitHubApi", () => {
  let fake: Awaited<ReturnType<typeof fakeGitHub>>;
  beforeAll(async () => {
    fake = await fakeGitHub();
  });
  afterAll(() => {
    fake.server.close();
  });

  it("pushes every file in one commit on the default branch", async () => {
    const api = new GitHubApi(fake.url);
    const result = await api.pushFiles({
      repository: "acme/app",
      token: "ghp_test",
      message: "Specification v1",
      directory: "docs/spec",
      files: [
        { path: "spec.md", content: "# Spec" },
        { path: "tasks/phase-1.md", content: "tasks" },
      ],
    });
    expect(result.files).toBe(2);
    expect(result.branch).toBe("main");
    expect(result.commitUrl).toBe(`https://github.com/acme/app/commit/${result.commitSha}`);
    const commit = fake.state.commits[result.commitSha];
    expect(commit).toMatchObject({ message: "Specification v1", parents: ["c0"] });
    const tree = fake.state.trees[commit?.tree ?? ""];
    expect(tree?.base).toBe("t0");
    expect(tree?.entries.map((e) => e.path)).toEqual(["docs/spec/spec.md", "docs/spec/tasks/phase-1.md"]);
    expect(fake.state.blobs[tree?.entries[0]?.sha ?? ""]).toBe("# Spec");
    expect(fake.state.refs.main).toBe(result.commitSha);
    expect(fake.state.requests.every((r) => r.auth === "Bearer ghp_test")).toBe(true);
  });

  it("creates a missing branch from the default branch", async () => {
    const api = new GitHubApi(fake.url);
    const result = await api.pushFiles({
      repository: "acme/app",
      branch: "spec/v2",
      token: "ghp_test",
      message: "v2",
      files: [{ path: "spec.md", content: "v2" }],
    });
    expect(result.branch).toBe("spec/v2");
    expect(fake.state.refs["spec/v2"]).toBe(result.commitSha);
    expect(fake.state.commits[result.commitSha]?.parents).toEqual([fake.state.refs.main]);
  });

  it("surfaces API errors with their status and rejects malformed repositories", async () => {
    const api = new GitHubApi(fake.url);
    await expect(
      api.pushFiles({ repository: "acme/app", token: "wrong", message: "m", files: [] }),
    ).rejects.toMatchObject({ name: "GitHubError", status: 401 });
    await expect(
      api.pushFiles({ repository: "not a repo", token: "ghp_test", message: "m", files: [] }),
    ).rejects.toBeInstanceOf(GitHubError);
  });

  it("refuses a repository or branch that would climb out of /repos/ (D-266)", async () => {
    const api = new GitHubApi(fake.url);
    const before = fake.state.requests.length;
    for (const repository of ["../..", "acme/..", "./app", "../acme"]) {
      await expect(
        api.pushFiles({ repository, token: "ghp_test", message: "m", files: [] }),
      ).rejects.toBeInstanceOf(GitHubError);
    }
    for (const branch of ["../../../orgs/x", "a/../b", "x?y=1", "a b", "//x", "a#b"]) {
      await expect(
        api.pushFiles({ repository: "acme/app", branch, token: "ghp_test", message: "m", files: [] }),
      ).rejects.toBeInstanceOf(GitHubError);
    }
    // Nothing was sent for any of them.
    expect(fake.state.requests.length).toBe(before);
  });

  it("MemoryGitHub records pushes without the token", async () => {
    const mem = new MemoryGitHub();
    const r = await mem.pushFiles({
      repository: "a/b",
      token: "secret",
      message: "m",
      files: [{ path: "x", content: "y" }],
    });
    expect(r.files).toBe(1);
    expect(JSON.stringify(mem.pushes)).not.toContain("secret");
  });
});
