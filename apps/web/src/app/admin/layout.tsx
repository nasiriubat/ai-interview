import { cookies } from "next/headers";
import Link from "next/link";
import * as React from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { parseSidebar, SIDEBAR_COOKIE } from "@/components/admin/shell/sidebar-state";
import { CurrencyProvider } from "@/components/common/CurrencyProvider";
import { StateView } from "@/components/common/StateView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { getMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requestLocale();
  const r = await getMe();
  const me = r.ok ? r.me : null;
  const k = t.kit.states;
  const blocked =
    r.ok || r.reason === "unauthenticated"
      ? null
      : r.reason === "forbidden"
        ? {
            illustration: "lock" as const,
            code: k.code(403),
            title: k.forbidden.title,
            body: k.forbidden.body,
            retry: k.backHome,
            detail: undefined,
          }
        : r.reason === "suspended"
          ? {
              illustration: "suspended" as const,
              code: undefined,
              title: k.suspended.title,
              body: k.suspended.body,
              retry: t.app.retry,
              detail: undefined,
            }
          : r.reason === "maintenance"
            ? {
                illustration: "maintenance" as const,
                code: k.code(503),
                title: k.maintenance.title,
                body: k.maintenance.body,
                retry: t.app.retry,
                detail: k.maintenance.hint,
              }
            : {
                illustration: "offline" as const,
                code: undefined,
                title: k.unavailable.title,
                body: k.unavailable.body,
                retry: t.app.retry,
                detail: undefined,
              };
  const collapsed = parseSidebar((await cookies()).get(SIDEBAR_COOKIE)?.value);
  // The operator's sidebar carries the count of open errors (D-477). A failure here only means no
  // badge: the page itself must never depend on it.
  let openErrors: number | undefined;
  if (me?.user.role === "platform_operator") {
    try {
      openErrors = (await (await staffServer()).operator.errors.summary()).open24h;
    } catch {
      openErrors = undefined;
    }
  }
  return (
    <CurrencyProvider currency={me?.company?.currency}>
      <AdminShell me={me} initialCollapsed={collapsed} counts={{ openErrors }}>
        {blocked ? (
          <StateView
            size="panel"
            illustration={blocked.illustration}
            code={blocked.code}
            title={blocked.title}
            body={blocked.body}
            actions={
              <Button asChild variant="outline">
                <Link href="/admin">{blocked.retry}</Link>
              </Button>
            }
            detail={blocked.detail}
          />
        ) : (
          children
        )}
      </AdminShell>
    </CurrencyProvider>
  );
}
