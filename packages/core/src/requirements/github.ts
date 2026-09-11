/*
 * GitHub push port (FR-25): one commit with every bundle file on a branch of the owner's
 * repository. The token travels with the call and is never stored or logged.
 */

export interface GitHubPushInput {
  /** `owner/name` */
  repository: string;
  /** Defaults to the repository's default branch; a missing branch is created from it. */
  branch?: string;
  /** Directory the files go under; empty or absent for the repository root. */
  directory?: string;
  message: string;
  token: string;
  files: { path: string; content: string }[];
}

export interface GitHubPushResult {
  commitUrl: string;
  commitSha: string;
  branch: string;
  files: number;
}

export interface GitHubPort {
  pushFiles(input: GitHubPushInput): Promise<GitHubPushResult>;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

type Fetch = typeof fetch;

/** Git Data API client: ref, blobs, tree, commit, ref update. Base URL is configurable for tests. */
export class GitHubApi implements GitHubPort {
  constructor(
    private readonly baseUrl = "https://api.github.com",
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async pushFiles(input: GitHubPushInput): Promise<GitHubPushResult> {
    const repo = input.repository.trim().replace(/^\/+|\/+$/g, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new GitHubError(400, "Repository must be owner/name");
    const call = this.client(input.token);
    const dir = (input.directory ?? "").replace(/^\/+|\/+$/g, "");

    let branch = input.branch?.trim() ?? "";
    if (!branch) {
      const info = await call<{ default_branch: string }>("GET", `/repos/${repo}`);
      branch = info.default_branch;
    }
    let head = await this.refSha(call, repo, branch);
    if (!head) {
      const info = await call<{ default_branch: string }>("GET", `/repos/${repo}`);
      const base = await this.refSha(call, repo, info.default_branch);
      if (!base) throw new GitHubError(404, `Branch '${info.default_branch}' not found`);
      await call("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: base });
      head = base;
    }
    const commit = await call<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${head}`);

    const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
    for (const f of input.files) {
      const blob = await call<{ sha: string }>("POST", `/repos/${repo}/git/blobs`, {
        content: Buffer.from(f.content, "utf8").toString("base64"),
        encoding: "base64",
      });
      const path = f.path.replace(/^\/+/, "");
      tree.push({ path: dir ? `${dir}/${path}` : path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await call<{ sha: string }>("POST", `/repos/${repo}/git/trees`, {
      base_tree: commit.tree.sha,
      tree,
    });
    const newCommit = await call<{ sha: string; html_url?: string }>("POST", `/repos/${repo}/git/commits`, {
      message: input.message,
      tree: newTree.sha,
      parents: [head],
    });
    await call("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha, force: false });
    return {
      commitUrl: newCommit.html_url ?? `https://github.com/${repo}/commit/${newCommit.sha}`,
      commitSha: newCommit.sha,
      branch,
      files: input.files.length,
    };
  }

  private async refSha(
    call: ReturnType<GitHubApi["client"]>,
    repo: string,
    branch: string,
  ): Promise<string | undefined> {
    try {
      const ref = await call<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${branch}`);
      return ref.object.sha;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return undefined;
      throw e;
    }
  }

  private client(token: string) {
    return async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "aidp",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (!res.ok) {
        let message = `GitHub ${method} ${path} failed with ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) message = `${message}: ${parsed.message}`;
        } catch {
          // plain body
        }
        throw new GitHubError(res.status, message);
      }
      return (text ? JSON.parse(text) : {}) as T;
    };
  }
}

/** Records pushes instead of calling GitHub. Tests, and the worker where pushes never happen. */
export class MemoryGitHub implements GitHubPort {
  readonly pushes: Omit<GitHubPushInput, "token">[] = [];
  async pushFiles(input: GitHubPushInput): Promise<GitHubPushResult> {
    const { token: _token, ...rest } = input;
    this.pushes.push(rest);
    const branch = input.branch ?? "main";
    return {
      commitUrl: `https://github.com/${input.repository}/commit/memory${this.pushes.length}`,
      commitSha: `memory${this.pushes.length}`,
      branch,
      files: input.files.length,
    };
  }
}
