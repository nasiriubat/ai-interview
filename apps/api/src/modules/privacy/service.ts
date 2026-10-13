import { retentionStatus, type SettingsService } from "@aidp/core";
import type { PrismaClient } from "@prisma/client";

/** What an admin can check about retention without reading the code (spec 11). */
export class PrivacyService {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
  ) {}

  retention(companyId: string): ReturnType<typeof retentionStatus> {
    return retentionStatus({ db: this.db, settings: this.settings }, companyId);
  }
}
