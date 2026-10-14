import { cookies } from "next/headers";
import * as React from "react";
import { signOutAction } from "./actions";
import { AdminShell } from "@/components/admin/AdminShell";
import { parseSidebar, SIDEBAR_COOKIE } from "@/components/admin/shell/sidebar-state";
import { CurrencyProvider } from "@/components/common/CurrencyProvider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { getMe } from "@/lib/admin/me";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requestLocale();
  const r = await getMe();
  const me = r.ok ? r.me : null;
  const collapsed = parseSidebar((await cookies()).get(SIDEBAR_COOKIE)?.value);
  return (
    <CurrencyProvider currency={me?.company?.currency}>
      <AdminShell me={me} signOutAction={signOutAction} initialCollapsed={collapsed}>
        {!r.ok && r.reason === "forbidden" ? (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>{t.auth.forbiddenTitle}</AlertTitle>
            <AlertDescription>{t.auth.noAccess}</AlertDescription>
          </Alert>
        ) : null}
        {!r.ok && r.reason === "unavailable" ? (
          <Alert variant="warning" role="status" className="mb-4">
            <AlertTitle>{t.admin.common.loadFailed}</AlertTitle>
            <AlertDescription>{t.admin.dashboard.statsUnavailable}</AlertDescription>
          </Alert>
        ) : null}
        {children}
      </AdminShell>
    </CurrencyProvider>
  );
}
