import { PrismaClient } from "@prisma/client";

export { PrismaClient };
export type { Prisma } from "@prisma/client";

let client: PrismaClient | undefined;

/** Process-wide client. Tests and workers may construct their own. */
export function prisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

/**
 * Tenant-scoped access (FR-01, NFR-03). Every query through this object is filtered by
 * companyId via a Prisma client extension, so a module cannot forget the scope.
 * Postgres row-level security (migration 0002) is the second fence.
 */
export function forCompany(base: PrismaClient, companyId: string): ScopedClient {
  return buildScoped(base, companyId);
}

function buildScoped(base: PrismaClient, companyId: string) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!SCOPED_MODELS.has(model)) return query(args);
          const a = args as { where?: Record<string, unknown>; data?: unknown };
          if (
            operation.startsWith("find") ||
            operation === "count" ||
            operation === "aggregate" ||
            operation === "groupBy" ||
            operation.startsWith("update") ||
            operation.startsWith("delete")
          ) {
            a.where = { ...(a.where ?? {}), companyId };
          }
          if (operation === "create" && a.data && typeof a.data === "object")
            a.data = { ...(a.data as Record<string, unknown>), companyId };
          if (operation === "createMany" && Array.isArray(a.data))
            a.data = (a.data as Record<string, unknown>[]).map((d) => ({ ...d, companyId }));
          return query(args);
        },
      },
    },
  });
}

/**
 * Models whose `companyId` the scoped client filters and stamps. Since migration 0016 every child
 * row carries its tenant too (D-140), so the scoped client no longer relies on a row being "reached
 * through its scoped parent".
 *
 * Deliberately absent: `Setting` and `ModelPrice`, whose NULL `companyId` means "platform" and has
 * to stay visible (like Provider and Route, but those are listed for historical reasons); the
 * settings service names its scopes explicitly and the database derives the owner (migration 0017).
 * `Company` is keyed by `id`, and `VerificationToken` is exempt (deploy/lib/rls-exempt.txt).
 */
export const SCOPED_MODELS: ReadonlySet<string> = new Set([
  "User",
  "Participant",
  "InterviewTemplate",
  "Campaign",
  "Session",
  "Attachment",
  "AttachmentChunk",
  "Fact",
  "Provider",
  "Route",
  "Budget",
  "LlmCall",
  "AuditLog",
  "SpecVersion",
  "Message",
  "SessionEvent",
  "Analysis",
  "Opportunity",
  "OpportunityEvidence",
  "Report",
  "ClusterEdit",
  "Invitation",
  "CampaignEmailHash",
  "EmailCode",
  "TenantStatement",
  "ErasureLedger",
  "UsageCounter",
  "CampaignDocument",
]);

export type ScopedClient = ReturnType<typeof buildScoped>;

export * from "./tenancy.js";
export { shippedTemplate, shippedTemplates } from "./seed-templates/index.js";
export { containsInsensitive, escapeLike } from "./search.js";
