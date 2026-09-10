import { LinkIcon } from "lucide-react";
import type { Metadata } from "next";
import * as React from "react";
import { InterviewScreen } from "@/components/participant/InterviewScreen";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { isApiError } from "@/lib/api/errors";
import { participantServer } from "@/lib/api/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).participant.session.title };
}

export default async function SessionPage(): Promise<React.JSX.Element> {
  const { api, hasToken } = await participantServer();
  if (!hasToken) {
    return (
      <StatusScreen
        icon={<LinkIcon />}
        tone="warning"
        title={t.participant.session.errorExpiredTitle}
        body={t.participant.session.errorExpiredBody}
      />
    );
  }
  try {
    const session = await api.getSession();
    if (!session.consented && session.messages.length === 0) {
      return (
        <StatusScreen
          icon={<LinkIcon />}
          title={t.participant.session.notConsentedTitle}
          body={t.participant.session.notConsentedBody}
        />
      );
    }
    return <InterviewScreen initial={session} />;
  } catch (e) {
    if (isApiError(e) && (e.isUnauthenticated || e.isNotFound || e.isForbidden)) {
      return (
        <StatusScreen
          icon={<LinkIcon />}
          tone="warning"
          title={t.participant.session.errorExpiredTitle}
          body={t.participant.session.errorExpiredBody}
        />
      );
    }
    throw e;
  }
}
