"use client";

import { BanIcon, BellIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";

const s = t.admin.campaigns;

/** States in which an invitation can still be answered, and so reminded or revoked. */
const LIVE = new Set(["pending", "sent", "opened"]);

/**
 * The two things an administrator can do to one invitation: send a reminder (a mail to a named
 * person, so only where there is an address and the invitation is still live) and revoke it (asks
 * first). Icon-only with the person's address in the name, so a screen reader hears who (D-361).
 */
export function InvitationActions({
  campaignId,
  invitationId,
  email,
  status,
}: {
  campaignId: string;
  invitationId: string;
  email: string | null;
  status: string;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const who = email ?? s.anonymousEmail;

  const remind = (): void => {
    setBusy(true);
    staffClient.campaigns
      .remind(campaignId, invitationId)
      .then(() => {
        notify.success(s.reminded);
        router.refresh();
      })
      .catch((e: unknown) => {
        notify.error(e, { retry: remind });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <RowActions>
        <IconButton
          label={`${s.remind}: ${who}`}
          icon={<BellIcon />}
          disabled={busy || !LIVE.has(status) || !email}
          onClick={remind}
        />
        <IconButton
          label={`${s.revoke}: ${who}`}
          icon={<BanIcon />}
          className="text-muted-foreground hover:text-destructive"
          disabled={busy || status === "revoked" || status === "bound"}
          onClick={() => {
            setRevoking(true);
          }}
        />
      </RowActions>
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={s.revokeTitle}
        description={<p>{s.revokeBody(who)}</p>}
        confirmLabel={s.revokeConfirm}
        pending={busy}
        onConfirm={() => {
          setBusy(true);
          staffClient.campaigns
            .revoke(campaignId, invitationId)
            .then(() => {
              notify.success(s.revoked);
              router.refresh();
            })
            .catch((e: unknown) => {
              notify.error(e);
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      />
    </>
  );
}
