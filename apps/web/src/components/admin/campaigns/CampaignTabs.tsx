import Link from "next/link";
import * as React from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export const CAMPAIGN_TABS = ["overview", "invitations", "sessions", "analysis", "settings"] as const;
export type CampaignTab = (typeof CAMPAIGN_TABS)[number];

/** `?tab=` as a tab, or the overview for anything else (a stale link, a typo). */
export function tabFrom(value: string | string[] | undefined): CampaignTab {
  const v = Array.isArray(value) ? value[0] : value;
  return CAMPAIGN_TABS.find((tab) => tab === v) ?? "overview";
}

/**
 * The campaign's sections as links, not as script-driven tabs: each section is its own address,
 * rendered on the server, so a reload, a shared link and the back button all land where they were.
 * That is the pattern the settings categories use. The current section carries `aria-current`.
 */
export function CampaignTabs({
  campaignId,
  current,
}: {
  campaignId: string;
  current: CampaignTab;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  return (
    <nav aria-label={s.tabsLabel} className="-mx-1 overflow-x-auto px-1">
      <ul className="flex min-w-max gap-3 border-b sm:gap-5">
        {CAMPAIGN_TABS.map((tab) => {
          const active = tab === current;
          return (
            <li key={tab}>
              <Link
                href={`/admin/campaigns/${campaignId}${tab === "overview" ? "" : `?tab=${tab}`}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center border-b-2 px-0.5 text-[13px] font-medium whitespace-nowrap sm:text-sm transition-colors",
                  active
                    ? "border-primary text-primary"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {s.tabs[tab]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
