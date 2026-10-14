import { createHash } from "node:crypto";
import type { SettingsService } from "@aidp/core";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import type { AuditService } from "../audit/service.js";
import { inspectLogo, LOGO_MAX_BYTES, type LogoProblem } from "./image.js";

const LOGO_KEY = "logo";

/** What the public branding endpoint answers: names and a version, never a tenant's data. */
export interface PublicBranding {
  productName: string;
  hasLogo: boolean;
  /** A content hash of the logo, or null without one. The web app puts it in the image URL. */
  logoVersion: string | null;
}

export interface LogoFile {
  contentType: string;
  bytes: Buffer;
  version: string;
}

/** Why a logo was refused, in words an operator can act on. The code is `validation` for all. */
const PROBLEM: Record<LogoProblem, string> = {
  empty: "The file is empty.",
  too_large: `The logo must be ${String(LOGO_MAX_BYTES / 1024)} KB or smaller.`,
  unsupported_type: "The logo must be a PNG, JPEG or WebP image. SVG is not accepted.",
  unreadable: "The image could not be read. Save it again as PNG, JPEG or WebP and retry.",
  bad_dimensions:
    "The logo must be between 16 and 4096 pixels on each side, and no more than 12 times as wide as it is tall.",
};

/**
 * The platform's own name and logo (D-430 to D-434).
 *
 * The name is the platform scope of `branding.productName`, read with an empty chain so a tenant's
 * override, which names that tenant's interviews, never leaks onto the public site. The logo is one
 * row of `PlatformAsset`; it is platform-wide and public, so no tenant context applies to it.
 */
export class BrandingService {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async publicBranding(): Promise<PublicBranding> {
    const [productName, logo] = await Promise.all([
      this.settings.get("branding.productName", []),
      this.db.platformAsset.findUnique({ where: { key: LOGO_KEY }, select: { version: true } }),
    ]);
    return { productName, hasLogo: logo !== null, logoVersion: logo?.version ?? null };
  }

  async logo(): Promise<LogoFile | null> {
    const row = await this.db.platformAsset.findUnique({ where: { key: LOGO_KEY } });
    if (!row) return null;
    return { contentType: row.contentType, bytes: Buffer.from(row.bytes), version: row.version };
  }

  /** Replaces the logo. The bytes are checked here, whatever the upload claimed they were. */
  async setLogo(actor: { userId: string; companyId: string }, bytes: Buffer): Promise<PublicBranding> {
    const check = inspectLogo(bytes);
    if (!check.ok)
      throw new AppError(check.problem === "too_large" ? "too_large" : "validation", PROBLEM[check.problem], {
        problem: check.problem,
      });
    const { contentType, width, height } = check.info;
    const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const data = {
      contentType,
      bytes: new Uint8Array(bytes),
      sizeBytes: bytes.length,
      width,
      height,
      version,
      updatedBy: actor.userId,
    };
    await this.db.platformAsset.upsert({
      where: { key: LOGO_KEY },
      create: { key: LOGO_KEY, ...data },
      update: data,
    });
    await this.audit.record(actor.companyId, {
      actorId: actor.userId,
      action: "branding.logo_update",
      targetType: "platform",
      targetId: "branding.logo",
      diff: { contentType, width, height, sizeBytes: bytes.length, version },
    });
    return this.publicBranding();
  }

  async removeLogo(actor: { userId: string; companyId: string }): Promise<PublicBranding> {
    const removed = await this.db.platformAsset.deleteMany({ where: { key: LOGO_KEY } });
    await this.audit.record(actor.companyId, {
      actorId: actor.userId,
      action: "branding.logo_remove",
      targetType: "platform",
      targetId: "branding.logo",
      diff: { removed: removed.count > 0 },
    });
    return this.publicBranding();
  }
}
