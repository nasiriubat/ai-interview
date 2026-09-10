import { MailIcon } from "lucide-react";
import * as React from "react";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { t } from "@/i18n";

export default function VerifyRequestPage(): React.JSX.Element {
  return <StatusScreen icon={<MailIcon />} title={t.auth.linkSent} body={t.auth.verifyRequest} />;
}
