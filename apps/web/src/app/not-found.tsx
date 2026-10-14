import Link from "next/link";
import * as React from "react";
import { AuthShell } from "@/components/common/AuthShell";
import { StateView } from "@/components/common/StateView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { staffTokenFromCookies } from "@/lib/api/server";

/**
 * The page nobody linked to. Most people who land here followed a mistyped or truncated
 * participant link, so the page must not send them to the staff sign-in (which is what `/` is).
 * The way back to the admin is offered only when a staff session cookie exists.
 */
export default async function NotFound(): Promise<React.JSX.Element> {
  await requestLocale();
  const isStaff = Boolean(await staffTokenFromCookies());
  const s = t.kit.states;
  return (
    <AuthShell variant="centered">
      <StateView
        illustration="notFound"
        code={s.code(404)}
        title={s.notFound.title}
        body={s.notFound.body}
        actions={
          isStaff ? (
            <Button asChild>
              <Link href="/admin">{s.backHome}</Link>
            </Button>
          ) : null
        }
      />
    </AuthShell>
  );
}
