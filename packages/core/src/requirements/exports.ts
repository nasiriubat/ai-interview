import { AgentBundleSchema } from "@aidp/shared";
import type { RequirementsContext } from "./context.js";
import { GitHubNotConfiguredError } from "./errors.js";
import { nonEmpty, slug } from "./helpers.js";
import type { ExportFormat, RequirementsServiceDeps, Viewer } from "./types.js";
import { zipFiles } from "./zip.js";

/** A version leaving the product: a file download, or a push to the owner's repository. */
export class RequirementsExports {
  constructor(private readonly cx: RequirementsContext) {}

  private get deps(): RequirementsServiceDeps {
    return this.cx.deps;
  }

  async exportVersion(
    companyId: string,
    id: string,
    v: number,
    format: ExportFormat,
    viewer: Viewer,
  ): Promise<{ filename: string; contentType: string; body: Buffer | string }> {
    const row = await this.cx.load(companyId, id, viewer);
    const version = await this.cx.versionRow(row.id, v);
    const document = this.cx.documentOf(version);
    const base = `${slug(row.title || document.title)}-v${version.version}`;
    if (format === "md")
      return { filename: `${base}.md`, contentType: "text/markdown; charset=utf-8", body: version.specMd };
    if (format === "json")
      return {
        filename: `${base}.json`,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(document, null, 2),
      };
    const bundle = AgentBundleSchema.parse(version.bundle);
    return { filename: `${base}-bundle.zip`, contentType: "application/zip", body: zipFiles(bundle.files) };
  }

  async pushToGitHub(
    companyId: string,
    id: string,
    v: number,
    input: {
      repository: string;
      branch?: string | undefined;
      directory?: string | undefined;
      token: string;
      message?: string | undefined;
    },
    viewer: Viewer,
  ): Promise<{ commitUrl: string; files: number; branch: string }> {
    if (!this.deps.github) throw new GitHubNotConfiguredError();
    const row = await this.cx.load(companyId, id, viewer);
    const version = await this.cx.versionRow(row.id, v);
    this.cx.documentOf(version); // must be done
    const bundle = AgentBundleSchema.parse(version.bundle);
    const result = await this.deps.github.pushFiles({
      repository: input.repository,
      ...(input.branch?.trim() ? { branch: input.branch.trim() } : {}),
      ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
      message: nonEmpty(input.message) ?? `Specification v${version.version}: ${row.title || "requirements"}`,
      token: input.token,
      files: bundle.files,
    });
    return { commitUrl: result.commitUrl, files: result.files, branch: result.branch };
  }
}
