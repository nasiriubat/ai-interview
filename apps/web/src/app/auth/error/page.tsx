import { AlertTriangleIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

export default async function AuthErrorPage(): Promise<React.JSX.Element> {
  await requestLocale();
  return (
    <StatusScreen icon={<AlertTriangleIcon />} tone="warning" title={t.app.errorTitle} body={t.auth.error}>
      <Button asChild>
        <Link href="/auth/signin">{t.app.signIn}</Link>
      </Button>
    </StatusScreen>
  );
}
