import * as React from "react";
import { signOutAction } from "./actions";
import { AdminShell } from "@/components/admin/AdminShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { t } from "@/i18n";
import { getMe } from "@/lib/admin/me";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const r = await getMe();
  const me = r.ok ? r.me : null;
  return (
    <AdminShell me={me} signOutAction={signOutAction}>
      {!r.ok && r.reason === "forbidden" ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>{t.auth.forbiddenTitle}</AlertTitle>
          <AlertDescription>{t.auth.noAccess}</AlertDescription>
        </Alert>
      ) : null}
      {!r.ok && r.reason === "unavailable" ? (
        <Alert variant="warning" className="mb-4">
          <AlertTitle>{t.admin.common.loadFailed}</AlertTitle>
          <AlertDescription>{t.admin.dashboard.statsUnavailable}</AlertDescription>
        </Alert>
      ) : null}
      {children}
    </AdminShell>
  );
}
