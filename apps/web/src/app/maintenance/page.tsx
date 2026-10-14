import type { Metadata } from "next";
import * as React from "react";
import { AuthShell } from "@/components/common/AuthShell";
import { StateView } from "@/components/common/StateView";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).kit.states.maintenance.title };
}

/**
 * The page a reverse proxy can serve while the API is being updated (rewrite `/` to `/maintenance`
 * with a 503). It needs no API: it is words and a picture.
 */
export default async function MaintenancePage(): Promise<React.JSX.Element> {
  await requestLocale();
  const s = t.kit.states;
  return (
    <AuthShell variant="centered">
      <StateView
        illustration="maintenance"
        code={s.code(503)}
        title={s.maintenance.title}
        body={s.maintenance.body}
        detail={s.maintenance.hint}
      />
    </AuthShell>
  );
}
