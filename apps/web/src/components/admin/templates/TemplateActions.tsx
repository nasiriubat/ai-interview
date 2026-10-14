"use client";

import { ArchiveIcon, CopyIcon, ExternalLinkIcon, PencilIcon, RocketIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { TemplateRecord } from "@/lib/api/schemas";

/**
 * The primary action of a template page (D-363): publish a draft, or edit a published template of
 * the organization. A built-in template is the platform's, so it has none.
 */
export function TemplatePrimaryAction({
  template,
  canManage,
}: {
  template: TemplateRecord;
  canManage: boolean;
}): React.JSX.Element | null {
  const s = t.admin.templates;
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  if (!canManage || !template.companyId) return null;
  if (template.status === "published") {
    return (
      <Button asChild>
        <Link href={`/admin/templates/${template.id}/edit`}>
          <PencilIcon aria-hidden="true" /> {s.edit}
        </Link>
      </Button>
    );
  }
  const publish = (): void => {
    setBusy(true);
    staffClient.templates
      .publish(template.id)
      .then(() => {
        notify.success(s.published);
        router.refresh();
      })
      .catch((e: unknown) => {
        notify.error(e, { retry: publish });
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Button loading={busy} onClick={publish}>
      <RocketIcon aria-hidden="true" /> {s.publish}
    </Button>
  );
}

/** The quieter actions, icon-only with tooltips: edit (draft), copy, preview, and archive (asks first). */
export function TemplateSecondaryActions({
  template,
  canManage,
}: {
  template: TemplateRecord;
  canManage: boolean;
}): React.JSX.Element {
  const s = t.admin.templates;
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const own = Boolean(template.companyId);

  return (
    <>
      {canManage && own && template.status !== "published" ? (
        <IconButton
          label={s.edit}
          variant="outline"
          size="icon"
          icon={<PencilIcon />}
          href={`/admin/templates/${template.id}/edit`}
        />
      ) : null}
      {canManage ? (
        <IconButton
          label={s.copy}
          variant="outline"
          size="icon"
          icon={<CopyIcon />}
          href={`/admin/templates/new?copyFrom=${template.id}`}
        />
      ) : null}
      <IconButton
        label={s.previewLabel}
        variant="outline"
        size="icon"
        icon={<ExternalLinkIcon />}
        href={`/api/preview/${template.id}`}
        external
      />
      {canManage && own && template.status !== "archived" ? (
        <IconButton
          label={s.archive}
          variant="outline"
          size="icon"
          icon={<ArchiveIcon />}
          disabled={busy}
          onClick={() => {
            setArchiving(true);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={s.archiveTitle(template.name)}
        description={<p>{s.archiveBody}</p>}
        confirmLabel={s.archiveConfirm}
        pending={busy}
        onConfirm={() => {
          setBusy(true);
          staffClient.templates
            .archive(template.id)
            .then(() => {
              notify.success(s.archived);
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
