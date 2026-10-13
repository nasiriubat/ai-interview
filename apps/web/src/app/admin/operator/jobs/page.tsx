import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { JobsPanel } from "@/components/admin/operator/JobsPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.jobs.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The background queue (D-92): counters per job type and the dead letters of the chosen one. */
export default async function JobsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const params = await searchParams;
  const requested = typeof params.queue === "string" ? params.queue : undefined;
  const api = await staffServer();
  const queuesR = await Promise.allSettled([api.operator.jobs.list()]);
  const queues = settled(queuesR[0]);
  const known = queues.data?.find((q) => q.name === requested)?.name;
  // With no choice made, show the first queue that has something to look at.
  const selected = known ?? queues.data?.find((q) => q.deadLettered > 0)?.name;
  const dead = selected
    ? settled((await Promise.allSettled([api.operator.jobs.dead(selected, 100)]))[0])
    : undefined;
  return (
    <>
      <PageHeader title={t.admin.operator.jobs.title} subtitle={t.admin.operator.jobs.subtitle} />
      {queues.data ? (
        <JobsPanel queues={queues.data} selected={selected} dead={dead?.data ?? []} />
      ) : (
        <LoadError error={queues.error} />
      )}
      {dead && !dead.data ? <LoadError error={dead.error} /> : null}
    </>
  );
}
