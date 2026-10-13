"use client";

import { CheckIcon, CopyIcon, LockIcon, PlayIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Campaign } from "@/lib/api/schemas";

const s = t.admin.campaigns;

export function CampaignActions({ campaign }: { campaign: Campaign }): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [copied, setCopied] = React.useState(false);
  const [confirmClose, setConfirmClose] = React.useState(false);
  const link = campaign.link?.url;
  const isOpen = campaign.status === "open";

  const copy = (): void => {
    if (!link) return;
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => undefined);
  };

  return (
    <div className="grid gap-3">
      {link ? (
        <div className="grid gap-1.5">
          <Label htmlFor="campaign-link">{s.linkTitle}</Label>
          <div className="flex gap-2">
            <Input
              id="campaign-link"
              readOnly
              value={link}
              className="font-mono text-xs"
              onFocus={(e) => {
                e.currentTarget.select();
              }}
            />
            <Button type="button" variant="outline" onClick={copy} aria-live="polite">
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? s.linkCopied : s.copyLink}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {isOpen ? (
          <Button
            variant="outline"
            disabled={action.busy}
            onClick={() => {
              setConfirmClose(true);
            }}
          >
            <LockIcon /> {s.close}
          </Button>
        ) : (
          <Button
            disabled={action.busy}
            onClick={() => {
              void action.run(async () => {
                await staffClient.campaigns.open(campaign.id);
                router.refresh();
              }, s.opened);
            }}
          >
            <PlayIcon /> {s.open}
          </Button>
        )}
      </div>
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
            await staffClient.campaigns.close(campaign.id);
            router.refresh();
          }, s.closed);
        }}
      />
    </div>
  );
}
