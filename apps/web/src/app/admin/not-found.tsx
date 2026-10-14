import Link from "next/link";
import * as React from "react";
import { StateView } from "@/components/common/StateView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

/** An admin address that does not exist (or an id the organization does not own): inside the shell. */
export default async function AdminNotFound(): Promise<React.JSX.Element> {
  await requestLocale();
  const s = t.kit.states;
  return (
    <StateView
      size="panel"
      illustration="notFound"
      code={s.code(404)}
      title={s.notFound.title}
      body={s.notFound.body}
      actions={
        <Button asChild>
          <Link href="/admin">{s.backHome}</Link>
        </Button>
      }
    />
  );
}
