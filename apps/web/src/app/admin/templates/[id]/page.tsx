import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { TemplateActions } from "@/components/admin/templates/TemplateActions";
import { TemplateDiff } from "@/components/admin/templates/TemplateDiff";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.templates.title };
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function TemplatePage({ params }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const { id } = await params;
  const api = await staffServer();
  const [tplR, diffR] = await Promise.allSettled([api.templates.get(id), api.templates.diffShipped(id)]);
  if (tplR.status === "rejected") {
    if (isApiError(tplR.reason) && tplR.reason.isNotFound) notFound();
    throw tplR.reason;
  }
  const tpl = tplR.value;
  const diff = settled(diffR);
  const s = t.admin.templates;
  const f = s.fields;
  return (
    <>
      <PageHeader
        title={tpl.name}
        subtitle={`${tpl.key} · v${tpl.version}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={tpl.status} />
            <Badge variant={tpl.companyId ? "secondary" : "outline"}>
              {tpl.companyId ? s.tenant : s.platform}
            </Badge>
          </div>
        }
      />
      <div className="grid gap-6">
        <TemplateActions template={tpl} />
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{s.sections.basics}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <Row label={f.objective} value={tpl.objective} />
              <Row label={f.privacyMode} value={f.privacy[tpl.privacyMode]} />
              <Row label={f.pathSelection} value={f.pathSelectionOptions[tpl.pathSelection]} />
              <Row label={f.language} value={tpl.language} />
              <Row
                label={f.participantFields}
                value={tpl.participantFields.map((p) => p.label).join(", ") || t.app.none}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{s.sections.closing}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <Row label={f.closingQuestion} value={tpl.closingQuestion} />
              <Row label={f.endSummary} value={tpl.endSummary ? t.app.yes : t.app.no} />
              <Row label={f.maxTurns} value={String(tpl.maxTurns)} />
              <Row label={f.maxAssistantChars} value={String(tpl.maxAssistantChars)} />
              <Row label={f.outputs} value={tpl.outputs.map((o) => s.factKinds[o]).join(", ")} />
              <Row label={f.analysisEnabled} value={tpl.analysisEnabled ? t.app.yes : t.app.no} />
              <Row label={f.chainToKey} value={tpl.chainToKey ?? t.app.none} />
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{s.sections.areas}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="grid gap-3">
              {tpl.coverageAreas.map((a, i) => (
                <li key={a.key} className="grid gap-1 text-sm">
                  <p className="font-medium">
                    {i + 1}. {a.name} <span className="text-muted-foreground font-mono text-xs">{a.key}</span>
                    {a.essential ? (
                      <Badge variant="secondary" className="ml-2">
                        {f.areaEssential.split(" (")[0]}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground">{a.description}</p>
                  <p className="text-muted-foreground text-xs">
                    {f.areaDoneWhen}: {a.doneWhen} · {f.areaMaxFollowUps}: {a.maxFollowUps}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        {tpl.contextBlock.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{s.sections.context}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-2 text-sm">
                {tpl.contextBlock.map((q) => (
                  <li key={q.key}>
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
            </CardContent>
          </Card>
        ) : null}
        {tpl.aiInstructions ? (
          <Card>
            <CardHeader>
              <CardTitle>{s.sections.ai}</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-sm whitespace-pre-wrap">{tpl.aiInstructions}</pre>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{s.diffTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {diff.data ? <TemplateDiff diff={diff.data} /> : <LoadError error={diff.error} />}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
