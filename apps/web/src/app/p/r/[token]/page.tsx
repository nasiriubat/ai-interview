import { CheckIcon, ClockIcon, LinkIcon, XIcon } from "lucide-react";
import type { Metadata } from "next";
import * as React from "react";
import { InviteArrival } from "@/components/participant/InviteArrival";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { isApiError } from "@/lib/api/errors";
import { participantApi } from "@/lib/api/participant";
import { publicTransport } from "@/lib/api/server";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).participant.invite.eyebrow };
}

/** Public arrival for a person invited into a requirements session (contract 18, `/p/r/:token`). */
export default async function InvitePage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const { token } = await params;
  const s = t.participant.invite;

  let info;
  try {
    info = await participantApi(publicTransport()).getInvite(token);
  } catch (e) {
    if (isApiError(e) && e.isNotFound) {
      return <StatusScreen icon={<LinkIcon />} tone="warning" title={s.invalidTitle} body={s.invalidBody} />;
    }
    throw e;
  }

  switch (info.status) {
    case "revoked":
      return <StatusScreen icon={<XIcon />} tone="warning" title={s.revokedTitle} body={s.revokedBody} />;
    case "expired":
      return <StatusScreen icon={<ClockIcon />} tone="warning" title={s.expiredTitle} body={s.expiredBody} />;
    case "completed":
      return (
        <StatusScreen icon={<CheckIcon />} tone="success" title={s.completedTitle} body={s.completedBody} />
      );
    case "open":
      return <InviteArrival token={token} session={info.session} />;
  }
}
