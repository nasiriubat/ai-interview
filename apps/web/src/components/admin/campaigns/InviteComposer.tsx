"use client";

import { SendIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { z } from "zod";
import { TextAreaField } from "@/components/admin/forms";
import { Panel } from "@/components/admin/Panel";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { ImportDialog } from "@/components/data/ImportDialog";
import { Form } from "@/components/form/Form";
import { useForm } from "@/components/form/useForm";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";

const s = t.admin.campaigns;

/** Above this many addresses a send is a mass email and asks first (the policy table, D-111). */
export const BULK_INVITE_CONFIRM_ABOVE = 50;

export function parseEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase();
    if (e.includes("@")) seen.add(e);
  }
  return [...seen];
}

const schema = z.object({
  emails: z.string().refine((v) => parseEmails(v).length > 0, { message: s.emailsRequired }),
});

/**
 * Where invitations are added (D-360): addresses are typed, pasted or imported from a file
 * (previewed before anything is added), counted as they are understood, and sent on one explicit
 * action; more than `BULK_INVITE_CONFIRM_ABOVE` asks first. The result is a toast and the list
 * below refreshes.
 */
export function InviteComposer({ campaignId }: { campaignId: string }): React.JSX.Element {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState(false);
  const clear = React.useRef<() => void>(() => undefined);
  const form = useForm({
    id: "invite",
    initial: { emails: "" },
    schema,
    labels: { emails: s.emailsLabel },
    savedText: null,
    onSubmit: async (v) => {
      const r = await staffClient.campaigns.invite(campaignId, parseEmails(v.emails));
      notify.success(s.invitationsResult(r.created, r.skipped));
      clear.current();
      router.refresh();
    },
  });
  clear.current = () => {
    form.set("emails", "");
  };
  const count = parseEmails(form.values.emails).length;

  const request = (): void => {
    if (count > BULK_INVITE_CONFIRM_ABOVE) setConfirm(true);
    else form.submit();
  };

  return (
    <Panel title={s.addInvitationsTitle} description={s.invitationsBody}>
      <div className="px-5 py-4">
        <Form form={form} bar={false} className="gap-3">
          <TextAreaField {...form.field("emails")} label={s.emailsLabel} hint={s.emailsHint} rows={4} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" loading={form.submitting} disabled={count === 0} onClick={request}>
              <SendIcon aria-hidden="true" /> {count > 0 ? s.sendCount(count) : s.sendInvitations}
            </Button>
            <ImportDialog
              trigger={s.uploadFile}
              title={s.uploadFile}
              description={s.importBody}
              accept={[".txt", ".csv", "text/plain", "text/csv"]}
              onImport={(rows) => {
                const prev = form.values.emails;
                form.set("emails", prev ? `${prev}\n${rows.join("\n")}` : rows.join("\n"));
              }}
            />
            <p role="status" className="text-muted-foreground text-sm">
              {count > 0 ? s.emailsRecognised(count) : ""}
            </p>
          </div>
        </Form>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={s.bulkTitle(count)}
        description={<p>{s.bulkBody(count)}</p>}
        confirmLabel={s.bulkConfirm(count)}
        tone="default"
        onConfirm={form.submit}
      />
    </Panel>
  );
}
