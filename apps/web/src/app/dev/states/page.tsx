import { notFound } from "next/navigation";
import * as React from "react";
import { StateView } from "@/components/common/StateView";
import { Illustration, type IllustrationName } from "@/components/ui/illustrations";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

export const dynamic = "force-dynamic";

const ALL: IllustrationName[] = [
  "mail",
  "notFound",
  "error",
  "lock",
  "suspended",
  "offline",
  "maintenance",
  "expired",
  "campaign",
  "template",
  "users",
  "results",
  "search",
  "inbox",
];

/**
 * The global states and the illustration set, in one place for review (D-391, D-392). Like the kit
 * gallery, dev servers and the e2e build only.
 */
export default async function StatesGallery(): Promise<React.JSX.Element> {
  await requestLocale();
  if (process.env.NODE_ENV === "production" && process.env.UI_GALLERY !== "1") notFound();
  const s = t.kit.states;
  const e = t.kit.emptyStates;
  return (
    <main id="main" className="mx-auto grid max-w-6xl gap-10 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">States</h1>
      <section aria-labelledby="g-states" className="grid gap-4">
        <h2 id="g-states" className="text-lg font-semibold">
          Global
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <StateView
            size="panel"
            headingLevel={2}
            illustration="notFound"
            code={s.code(404)}
            title={s.notFound.title}
            body={s.notFound.body}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="error"
            code={s.code(500)}
            title={s.error.title}
            body={s.error.body}
            detail={s.error.reference("a1b2c3")}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="lock"
            code={s.code(403)}
            title={s.forbidden.title}
            body={s.forbidden.body}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="expired"
            title={s.expired.title}
            body={s.expired.body}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="maintenance"
            code={s.code(503)}
            title={s.maintenance.title}
            body={s.maintenance.body}
            detail={s.maintenance.hint}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="suspended"
            title={s.suspended.title}
            body={s.suspended.body}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="offline"
            title={s.unavailable.title}
            body={s.unavailable.body}
          />
        </div>
      </section>
      <section aria-labelledby="g-empty" className="grid gap-4">
        <h2 id="g-empty" className="text-lg font-semibold">
          Empty
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <StateView
            size="panel"
            headingLevel={2}
            illustration="campaign"
            title={e.campaigns.title}
            body={e.campaigns.text}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="template"
            title={e.templates.title}
            body={e.templates.text}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="users"
            title={e.users.title}
            body={e.users.text}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="results"
            title={e.results.title}
            body={e.results.text}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="search"
            title={e.search.title}
            body={e.search.text}
          />
          <StateView
            size="panel"
            headingLevel={2}
            illustration="inbox"
            title={e.generic.title}
            body={e.generic.text}
          />
        </div>
      </section>
      <section aria-labelledby="g-set" className="grid gap-4">
        <h2 id="g-set" className="text-lg font-semibold">
          Illustration set
        </h2>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
          {ALL.map((n) => (
            <li
              key={n}
              className="bg-card shadow-card grid justify-items-center gap-1 rounded-lg p-3 text-xs"
            >
              <Illustration name={n} className="w-24" />
              {n}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
