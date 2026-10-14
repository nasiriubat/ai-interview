import type { Logger } from "@aidp/ai";
import type { Handoff, Path, SessionState, SpecVersionStats } from "@aidp/shared";
import type { InterviewTemplate as TemplateRow, PrismaClient, Session } from "@prisma/client";
import type { TenantNotices } from "../alerts/tenant-notices.js";
import type { Crypto } from "../crypto.js";
import type { EmailPort } from "../email/port.js";
import type { PdfExporter } from "../exports/exporter.js";
import type { JobPublisher } from "../jobs/definitions.js";
import type { CallerFactory } from "../providers/caller-factory.js";
import type { SettingsService } from "../settings/service.js";
import type { GitHubPort } from "./github.js";

export interface RequirementsServiceDeps {
  db: PrismaClient;
  callers: CallerFactory;
  settings: SettingsService;
  jobs: JobPublisher;
  log: Logger;
  email: EmailPort;
  publicWebUrl: string;
  crypto: Crypto;
  /** Tenant notices (D-181): told when a version is generated. Absent in tools that never mail. */
  notices?: TenantNotices;
  /** PDF composition and diagram checks (D-210). Absent where they never happen (the worker). */
  exporter?: PdfExporter;
  /** Absent where pushes never happen (the worker). */
  github?: GitHubPort;
}

export interface Viewer {
  userId: string;
  role: "platform_operator" | "admin" | "member";
}

export interface ProgressArea {
  key: string;
  name: string;
  status: string;
}

/** `RequirementsSession` of contract 18. */
export interface RequirementsSession {
  id: string;
  title: string;
  status: string;
  path: Path | null;
  sourceKind: string;
  ownerUserId: string | null;
  handoff: Handoff | null;
  templateId: string;
  language: string;
  progress: { areas: ProgressArea[] };
  phase: SessionState["phase"];
  createdAt: Date;
  startedAt?: Date;
  endedAt?: Date;
}

export interface RequirementsListItem {
  id: string;
  title: string;
  status: string;
  path: Path | null;
  sourceKind: string;
  ownerUserId: string | null;
  ownerEmail?: string;
  versions: number;
  openFindings: number;
  createdAt: Date;
  endedAt?: Date;
}

export interface SpecVersionSummary {
  id: string;
  version: number;
  label?: string;
  status: string;
  error?: string;
  createdBy?: string;
  createdAt: Date;
  finishedAt?: Date;
  stats: SpecVersionStats;
}

export type ExportFormat = "md" | "json" | "bundle" | "pdf";

export interface InviteView {
  session: {
    title: string;
    productName: string;
    purpose: string;
    consentText: string;
    consentVersion: string;
    pathSelection: string;
    language: string;
  };
  status: "open" | "revoked" | "expired" | "completed";
}

export type SessionRow = Session & { template: TemplateRow };
