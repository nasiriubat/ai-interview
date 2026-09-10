import { ClockIcon, LinkIcon, LockIcon } from "lucide-react";
import type { Metadata } from "next";
import * as React from "react";
import { ArrivalFlow } from "@/components/participant/ArrivalFlow";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { t } from "@/i18n";
import { isApiError } from "@/lib/api/errors";
import { participantApi } from "@/lib/api/participant";
import { publicTransport } from "@/lib/api/server";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ linkToken: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = { title: t.participant.arrival.eyebrow };

export default async function ArrivalPage({ params, searchParams }: Props): Promise<React.JSX.Element> {
  const { linkToken } = await params;
  const sp = await searchParams;
  const invitationToken = typeof sp.invitation === "string" ? sp.invitation : undefined;

  let info;
  try {
    info = await participantApi(publicTransport()).getLink(linkToken);
  } catch (e) {
    if (isApiError(e) && e.isNotFound) {
      return (
        <StatusScreen
          icon={<LinkIcon />}
          tone="warning"
          title={t.participant.arrival.invalidTitle}
          body={t.participant.arrival.invalidBody}
        />
      );
    }
    throw e;
  }

  if (info.status === "closed") {
    return (
      <StatusScreen
        icon={<LockIcon />}
        title={t.participant.arrival.closedTitle}
        body={t.participant.arrival.closedBody}
      />
    );
  }
  if (info.status === "expired") {
    return (
      <StatusScreen
        icon={<ClockIcon />}
        tone="warning"
        title={t.participant.arrival.expiredTitle}
        body={t.participant.arrival.expiredBody}
      />
    );
  }
  return <ArrivalFlow linkToken={linkToken} campaign={info.campaign} invitationToken={invitationToken} />;
}
