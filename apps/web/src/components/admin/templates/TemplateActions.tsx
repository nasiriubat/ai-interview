"use client";

import { ArchiveIcon, CopyIcon, ExternalLinkIcon, PencilIcon, RocketIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { TemplateRecord } from "@/lib/api/schemas";

export function TemplateActions({ template }: { template: TemplateRecord }): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const s = t.admin.templates;
  const isPlatform = !template.companyId;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {!isPlatform ? (
          <Button asChild variant="outline">
            <Link href={`/admin/templates/${template.id}/edit`}>
              <PencilIcon /> {s.edit}
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="outline">
          <Link href={`/admin/templates/new?copyFrom=${template.id}`}>
            <CopyIcon /> {s.copy}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <a href={`/api/preview/${template.id}`} target="_blank" rel="noopener">
            <ExternalLinkIcon /> {s.preview}
          </a>
        </Button>
        {template.status !== "published" && !isPlatform ? (
          <Button
            disabled={action.busy}
            onClick={() => {
              void action.run(async () => {
                await staffClient.templates.publish(template.id);
                router.refresh();
              }, s.published);
            }}
          >
            <RocketIcon /> {s.publish}
          </Button>
        ) : null}
        {template.status !== "archived" && !isPlatform ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" disabled={action.busy}>
                <ArchiveIcon /> {s.archive}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{s.archive}</AlertDialogTitle>
                <AlertDialogDescription>{template.name}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t.app.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    void action.run(async () => {
                      await staffClient.templates.archive(template.id);
                      router.refresh();
                    }, s.archived);
                  }}
                >
                  {t.app.confirm}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
      <Flash flash={action.flash} />
    </div>
  );
}
