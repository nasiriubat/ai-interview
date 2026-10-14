import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { Panel } from "@/components/admin/Panel";
import { StatusBadge } from "@/components/admin/StatusBadge";
import {
  TemplatePrimaryAction,
  TemplateSecondaryActions,
} from "@/components/admin/templates/TemplateActions";
import { TemplateDiff } from "@/components/admin/templates/TemplateDiff";
import { VersionsPanel } from "@/components/admin/templates/VersionsPanel";
import { VoiceSwitch } from "@/components/admin/templates/VoiceSwitch";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";
import { label } from "@/lib/i18n/enums";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.templates.title };
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function TemplatePage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const { id } = await params;
  const api = await staffServer();
  const [tplR, diffR, versionsR, settingsR] = await Promise.allSettled([
    api.templates.get(id),
    api.templates.diffShipped(id),
    api.templates.versions(id),
    // The template's own settings, to show whether voice is switched off for it.
    api.settings.get({ scope: "template", scopeId: id }),
  ]);
  if (tplR.status === "rejected") {
    if (isApiError(tplR.reason) && tplR.reason.isNotFound) notFound();
    throw tplR.reason;
  }
  const tpl = tplR.value;
  const diff = settled(diffR);
  const versions = settled(versionsR);
  const voiceOn = settled(settingsR).data?.values["voice.enabled"] !== false;
  const isAdmin = me?.user.role === "admin" || me?.user.role === "platform_operator";
  const s = t.admin.templates;
  const f = s.fields;
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: tpl.name }}
        title={tpl.name}
        subtitle={`${tpl.key} · v${String(tpl.version)}`}
        meta={
          <>
            <StatusBadge status={tpl.status} />
            <Badge variant={tpl.companyId ? "secondary" : "outline"}>
              {tpl.companyId ? s.tenant : s.platform}
            </Badge>
          </>
        }
        actions={<TemplatePrimaryAction template={tpl} canManage={isAdmin} />}
        secondaryActions={<TemplateSecondaryActions template={tpl} canManage={isAdmin} />}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        {isAdmin ? <VoiceSwitch templateId={tpl.id} initial={voiceOn} disabled={!tpl.companyId} /> : null}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
          <Panel title={s.sections.basics}>
            <dl className="grid gap-3 px-5 py-4 text-sm">
              <Row label={f.objective} value={tpl.objective} />
              <Row label={f.privacyMode} value={f.privacy[tpl.privacyMode]} />
              <Row label={f.pathSelection} value={f.pathSelectionOptions[tpl.pathSelection]} />
              <Row label={f.language} value={label("language", tpl.language)} />
              <Row
                label={f.participantFields}
                value={tpl.participantFields.map((p) => p.label).join(", ") || t.app.none}
              />
            </dl>
          </Panel>
          <Panel title={s.sections.closing}>
            <dl className="grid gap-3 px-5 py-4 text-sm">
              <Row label={f.closingQuestion} value={tpl.closingQuestion} />
              <Row label={f.endSummary} value={tpl.endSummary ? t.app.yes : t.app.no} />
              <Row label={f.maxTurns} value={String(tpl.maxTurns)} />
              <Row label={f.maxAssistantChars} value={String(tpl.maxAssistantChars)} />
              <Row label={f.outputs} value={tpl.outputs.map((o) => s.factKinds[o]).join(", ")} />
              <Row label={f.analysisEnabled} value={tpl.analysisEnabled ? t.app.yes : t.app.no} />
              <Row label={f.chainToKey} value={tpl.chainToKey ?? t.app.none} />
            </dl>
          </Panel>
        </div>
        <Panel title={s.sections.areas}>
          <ol className="divide-y">
            {tpl.coverageAreas.map((a, i) => (
              <li key={a.key} className="grid gap-1 px-5 py-3 text-sm">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                  <span>
                    {i + 1}. {a.name}
                  </span>
                  <span className="text-muted-foreground font-mono text-xs font-normal">{a.key}</span>
                  {a.essential ? <Badge variant="secondary">{f.areaEssential.split(" (")[0]}</Badge> : null}
                </p>
                <p className="text-muted-foreground">{a.description}</p>
                <p className="text-muted-foreground text-xs">
                  {f.areaDoneWhen}: {a.doneWhen} · {f.areaMaxFollowUps}: {a.maxFollowUps}
                </p>
              </li>
            ))}
          </ol>
        </Panel>
        {tpl.contextBlock.length > 0 ? (
          <Panel title={s.sections.context}>
            <ol className="divide-y">
              {tpl.contextBlock.map((q) => (
                <li key={q.key} className="px-5 py-3 text-sm">
                  <span className="font-medium">{q.question}</span>
                  {q.default ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {f.contextDefault}: {q.default}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </Panel>
        ) : null}
        {tpl.aiInstructions ? (
          <Panel title={s.sections.ai}>
            <pre className="px-5 py-4 text-sm break-words whitespace-pre-wrap">{tpl.aiInstructions}</pre>
          </Panel>
        ) : null}
        {versions.data ? (
          <VersionsPanel
            versions={versions.data}
            currentId={tpl.id}
            canRestore={isAdmin && Boolean(tpl.companyId)}
          />
        ) : (
          <LoadError error={versions.error} />
        )}
        <Panel title={s.diffTitle}>
          <div className="px-5 py-4">
            {diff.data ? <TemplateDiff diff={diff.data} /> : <LoadError error={diff.error} />}
          </div>
        </Panel>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
