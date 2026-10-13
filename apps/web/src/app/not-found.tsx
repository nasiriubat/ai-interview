import { FileQuestionIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { StatusScreen } from "@/components/participant/StatusScreen";
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
  return (
    <StatusScreen icon={<FileQuestionIcon />} title={t.app.notFoundTitle} body={t.app.notFoundBody}>
      {isStaff ? (
        <Button asChild>
          <Link href="/admin">{t.app.notFoundDashboard}</Link>
        </Button>
      ) : null}
    </StatusScreen>
  );
}
