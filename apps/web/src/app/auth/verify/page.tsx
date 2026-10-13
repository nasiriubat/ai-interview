import { MailIcon } from "lucide-react";
import * as React from "react";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

export default async function VerifyRequestPage(): Promise<React.JSX.Element> {
  await requestLocale();
  return <StatusScreen icon={<MailIcon />} title={t.auth.linkSent} body={t.auth.verifyRequest} />;
}
