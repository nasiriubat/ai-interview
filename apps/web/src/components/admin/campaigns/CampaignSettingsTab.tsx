import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { SettingsResponse } from "@/lib/api/schemas";
import { settingText } from "@/lib/i18n/enums";

/** A value short enough for a row; secrets are never shown, only that one is set. */
export function shortValue(value: unknown, secret: boolean): string {
  if (secret) return "••••••";
  if (value === null || value === undefined) return t.admin.common.dash;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/**
 * Where this campaign differs from the organization, and the way into the scoped settings
 * (D-237). The values themselves are edited on the settings page, with their inherited values and
 * sources shown there; this tab answers "what is special about this campaign" and links to it.
 */
export function CampaignSettingsTab({
  campaignId,
  settings,
}: {
  campaignId: string;
  settings: SettingsResponse;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  const catalog = new Map(settings.catalog.map((c) => [c.key, c]));
  const changed = Object.keys(settings.values)
    .filter((k) => !k.startsWith("_"))
    .sort();
  const base = `/admin/settings?scope=campaign&scopeId=${encodeURIComponent(campaignId)}`;
  return (
    <Panel
      title={s.settingsTitle}
      description={s.settingsBody}
      actions={
        <Button asChild size="sm">
          <Link href={base}>
            <SettingsIcon aria-hidden="true" /> {s.settingsOpen}
          </Link>
        </Button>
      }
    >
      <div className="grid gap-3 px-5 py-4 text-sm">
        {changed.length === 0 ? (
          <p>{s.settingsNone}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{s.settingsChanged(changed.length)}</p>
            <ul className="grid gap-2">
              {changed.map((key) => {
                const entry = catalog.get(key);
                const text = settingText(key);
                const href = `${base}${entry ? `&category=${encodeURIComponent(entry.category)}` : ""}#setting-${key.replace(/\./g, "-")}`;
                return (
                  <li
                    key={key}
                    className="bg-muted/50 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg px-3 py-2"
                  >
                    <Link href={href} className="text-primary font-medium underline-offset-2 hover:underline">
                      {text?.label ?? key}
                    </Link>
                    <span className="text-muted-foreground font-mono text-xs break-all">
                      <span className="sr-only">{s.settingsValue}: </span>
                      {shortValue(settings.values[key], entry?.secret === true)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p>
          <Link href="/admin/settings" className="text-primary underline-offset-2 hover:underline">
            {s.settingsOrganization}
          </Link>
        </p>
      </div>
    </Panel>
  );
}
