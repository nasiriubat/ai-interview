import { AlertTriangleIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export default function AuthErrorPage(): React.JSX.Element {
  return (
    <StatusScreen icon={<AlertTriangleIcon />} tone="warning" title={t.app.errorTitle} body={t.auth.error}>
      <Button asChild>
        <Link href="/auth/signin">{t.app.signIn}</Link>
      </Button>
    </StatusScreen>
  );
}
