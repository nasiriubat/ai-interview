// Errors the requirements service throws; the API maps each to an HTTP status.

export class RequirementsNotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} not found`);
    this.name = "RequirementsNotFoundError";
  }
}
export class RequirementsForbiddenError extends Error {
  constructor() {
    super("You may only access your own requirements sessions");
    this.name = "RequirementsForbiddenError";
  }
}
export class SpecVersionInProgressError extends Error {
  constructor(readonly versionId: string) {
    super("A specification version is already queued or running for this session");
    this.name = "SpecVersionInProgressError";
  }
}
export class SpecVersionNotReadyError extends Error {
  constructor(
    readonly version: number,
    readonly status: string,
  ) {
    super(`Version ${version} is ${status}`);
    this.name = "SpecVersionNotReadyError";
  }
}
export class PathRequiredError extends Error {
  constructor() {
    super("Choose a path before the first turn");
    this.name = "PathRequiredError";
  }
}
export class InvalidSectionError extends Error {
  constructor(readonly key: string) {
    super(`Unknown specification section '${key}'`);
    this.name = "InvalidSectionError";
  }
}
export class SessionNotOpenError extends Error {
  constructor(readonly status: string) {
    super(`Session is ${status}`);
    this.name = "SessionNotOpenError";
  }
}
export class InviteNotOpenError extends Error {
  constructor(readonly status: string) {
    super(`This invitation is ${status}`);
    this.name = "InviteNotOpenError";
  }
}
export class GitHubNotConfiguredError extends Error {
  constructor() {
    super("GitHub push is not available in this process");
    this.name = "GitHubNotConfiguredError";
  }
}
export class DiagramInvalidError extends Error {
  constructor(readonly issues: { message: string; line?: number | undefined }[]) {
    super(issues[0]?.message ?? "The diagram is not valid");
    this.name = "DiagramInvalidError";
  }
}
export class DiagramNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`There is no edit to diagram '${key}'`);
    this.name = "DiagramNotFoundError";
  }
}
export class DiagramLimitError extends Error {
  constructor(readonly max: number) {
    super(`A specification holds at most ${max} diagrams`);
    this.name = "DiagramLimitError";
  }
}
/** A PDF or a diagram check was asked for in a process that has no exporter (the worker). */
export class PdfNotAvailableError extends Error {
  constructor() {
    super("PDF export is not available in this process");
    this.name = "PdfNotAvailableError";
  }
}
