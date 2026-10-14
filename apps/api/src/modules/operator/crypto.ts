import { keyUsage, type Crypto, type KeyUsage } from "@aidp/core";
import { withSystemTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";
import type { AuditService } from "../audit/service.js";

/**
 * Key rotation, from the operator's side (P9, D-164).
 *
 * The status says how many stored secrets each key in the ring still seals, which is the answer to
 * "can the previous key be removed yet": when `previousKeysRemovable` is true, yes. Starting a
 * re-key only queues the job (the route publishes it); the work happens in the worker,
 * idempotently. Nothing here returns or logs a key or a plaintext.
 */
export class CryptoAdminService {
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: Crypto,
    private readonly audit: AuditService,
  ) {}

  /** Platform-wide: every tenant's rows, so it reads as the system. */
  status(): Promise<KeyUsage> {
    return withSystemTenant(() => keyUsage(this.db, this.crypto));
  }

  /** Records that a re-key was asked for. Key ids are public names, not key material. */
  async recordRekeyRequested(actor: { userId: string }, companyId: string): Promise<void> {
    await this.audit.record(companyId, {
      actorId: actor.userId,
      action: "crypto.rekey_requested",
      targetType: "platform",
      targetId: this.crypto.activeKeyId,
      diff: { activeKeyId: this.crypto.activeKeyId, ring: this.crypto.keyIds },
    });
  }
}
