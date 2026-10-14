"use client";

import { LockIcon, PlayIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Campaign } from "@/lib/api/schemas";

/**
 * The campaign's primary action: open it, or close it. Closing asks first, because it stops
 * participants who are in the middle of an interview; opening is the obvious result of the click
 * and does not (D-111). The result is a toast and the page refreshes under it (D-361).
 */
export function CampaignActions({
  campaign,
}: {
  campaign: Pick<Campaign, "id" | "status">;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [confirmClose, setConfirmClose] = React.useState(false);
  const isOpen = campaign.status === "open";

  const run = (work: () => Promise<void>, done: string): void => {
    setBusy(true);
    work()
      .then(() => {
        notify.success(done);
        router.refresh();
      })
      .catch((e: unknown) => {
        notify.error(e, {
          retry: () => {
            run(work, done);
          },
        });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      {isOpen ? (
        <Button
          variant="outline"
          loading={busy}
          onClick={() => {
            setConfirmClose(true);
          }}
        >
          <LockIcon aria-hidden="true" /> {s.close}
        </Button>
      ) : (
        <Button
          loading={busy}
          onClick={() => {
            run(() => staffClient.campaigns.open(campaign.id), s.opened);
          }}
        >
          <PlayIcon aria-hidden="true" /> {s.open}
        </Button>
      )}
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={s.closeTitle}
        description={<p>{s.closeBody}</p>}
        confirmLabel={s.closeConfirm}
        tone="default"
        onConfirm={() => {
          run(() => staffClient.campaigns.close(campaign.id), s.closed);
        }}
      />
    </>
  );
}
