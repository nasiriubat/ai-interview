import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";

/**
 * `/requirements` (D-79): `q` matches the title. A member sees their own sessions and an admin
 * sees every owned session; search and filters narrow that set, never widen it. Deleted
 * sessions are never listed, so `deleted` is not a status filter.
 */
export const RequirementsList = listSpec({
  sort: { createdAt: "desc", title: "asc", status: "asc", lastActivity: "desc" },
  defaultSort: "createdAt",
  columns: { lastActivity: "updatedAt" },
  filters: {
    status: z.enum(["created", "consented", "active", "paused", "completed"]).optional(),
  },
});

export const RequirementsListQuery = listQuery(RequirementsList);
export type RequirementsListQuery = z.output<typeof RequirementsListQuery>;

/**
 * The query the requirements service (packages/core) takes, built from a parsed request. The core
 * service speaks Prisma `orderBy`, so the translation lives here and the route never sees it.
 */
export function requirementsListArgs(query: RequirementsListQuery): {
  limit: number;
  offset: number;
  q: string | undefined;
  status: RequirementsListQuery["status"];
  orderBy: Prisma.SessionOrderByWithRelationInput[];
} {
  return {
    limit: query.limit,
    offset: query.offset,
    q: searchTerm(query.q),
    status: query.status,
    orderBy: listOrder<Prisma.SessionOrderByWithRelationInput, typeof query.sort>(RequirementsList, query),
  };
}
