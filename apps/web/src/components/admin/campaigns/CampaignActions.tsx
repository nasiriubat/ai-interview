"use client";

import { LockIcon, PlayIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Campaign } from "@/lib/api/schemas";

/**
 * Open and close. Closing asks first, because it stops participants who are in the middle of an
 * interview; opening is the obvious result of the click and does not (D-111).
 */
export function CampaignActions({
  campaign,
}: {
  campaign: Pick<Campaign, "id" | "status">;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  const campaignId = campaign.id;
  const router = useRouter();
  const action = useAction();
  const [confirmClose, setConfirmClose] = React.useState(false);
  const isOpen = campaign.status === "open";

  return (
    <>
      {isOpen ? (
        <Button
          variant="outline"
          size="sm"
          disabled={action.busy}
          onClick={() => {
            setConfirmClose(true);
          }}
        >
          <LockIcon aria-hidden="true" /> {s.close}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={action.busy}
          onClick={() => {
            void action.run(async () => {
              await staffClient.campaigns.open(campaignId);
              router.refresh();
            }, s.opened);
          }}
        >
          <PlayIcon aria-hidden="true" /> {s.open}
        </Button>
      )}
      <Flash flash={action.flash} />
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={s.closeTitle}
        description={<p>{s.closeBody}</p>}
        confirmLabel={s.closeConfirm}
        tone="default"
        onConfirm={() => {
          void action.run(async () => {
            await staffClient.campaigns.close(campaignId);
            router.refresh();
          }, s.closed);
        }}
      />
    </>
  );
}
