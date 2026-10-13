import { LinkIcon } from "lucide-react";
import * as React from "react";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

/**
 * A participant route that does not exist. There is deliberately no button: `/` is the staff
 * sign-in, and the only useful recovery is the link from the invitation, which is text.
 */
export default async function ParticipantNotFound(): Promise<React.JSX.Element> {
  await requestLocale();
  return (
    <StatusScreen
      icon={<LinkIcon />}
      tone="warning"
      title={t.participant.arrival.invalidTitle}
      body={t.participant.arrival.invalidBody}
    />
  );
}
