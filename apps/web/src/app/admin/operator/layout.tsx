import { ShieldAlertIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { t } from "@/i18n";
import { hasRole, requireMe } from "@/lib/admin/me";

/** Platform operator only. Others see a forbidden notice instead of the pages. */
export default async function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const me = await requireMe();
  if (!hasRole(me, ["platform_operator"])) {
    return (
      <Alert variant="destructive" className="max-w-xl">
        <ShieldAlertIcon />
        <AlertTitle>{t.auth.forbiddenTitle}</AlertTitle>
        <AlertDescription>{t.auth.forbiddenBody}</AlertDescription>
      </Alert>
    );
  }
  return <>{children}</>;
}
