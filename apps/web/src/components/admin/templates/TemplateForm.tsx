"use client";

import {
  FACT_KINDS,
  InterviewTemplateSchema,
  WIDGET_TYPES,
  type ContextQuestion,
  type CoverageArea,
  type InterviewTemplate,
  type ParticipantField,
} from "@aidp/shared";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ListEditor } from "./ListEditor";
import { Flash, useAction } from "@/components/admin/Flash";
import {
  Field,
  FormSection,
  NumberField,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
  type FieldErrors,
} from "@/components/admin/forms";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";

const s = t.admin.templates;
const f = s.fields;

export const emptyTemplate: InterviewTemplate = {
  key: "",
  version: 1,
  name: "",
  language: "en",
  objective: "",
  privacyMode: "identified",
  participantFields: [],
  pathSelection: "none",
  contextBlock: [],
  coverageAreas: [],
  aiInstructions: "",
  adaptivity: {
    followUpPolicy: "clarify_ambiguous_and_deepen_processes",
    minimalAnswerThreshold: 3,
    offerPathSwitch: true,
    toneByRole: true,
  },
  widgetPolicy: { allowedTypes: [...WIDGET_TYPES], maxPerTurns: 1, everyTurns: 2 },
  issueDetection: {
    enabled: false,
    everyTurns: 5,
    aggressiveness: "standard",
    typesEnabled: ["ambiguity", "contradiction", "missing_decision", "over_complexity"],
    pushBackOnce: true,
    mvpChallenge: false,
  },
  outputs: [],
  analysisEnabled: false,
  chainToKey: null,
  chainMapping: null,
  closingQuestion: "Is there anything important I did not ask about?",
  endSummary: true,
  maxTurns: 60,
  maxAssistantChars: 600,
};

const ISSUE_TYPES = ["ambiguity", "contradiction", "missing_decision", "over_complexity"] as const;
type IssueType = (typeof ISSUE_TYPES)[number];

function optionsToText(options: ContextQuestion["options"]): string {
  return (options ?? [])
    .map((o) => [o.key, o.label, o.detail].filter((x) => x !== undefined).join(" | "))
    .join("\n");
}
function textToOptions(text: string): ContextQuestion["options"] {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("|").map((p) => p.trim()))
    .map(([key = "", label = "", detail]) => ({ key, label: label || key, ...(detail ? { detail } : {}) }))
    .filter((o) => o.key);
  return rows.length ? rows : undefined;
}
function mappingToText(m: Record<string, string> | null): string {
  return m
    ? Object.entries(m)
        .map(([a, b]) => `${a} = ${b}`)
        .join("\n")
    : "";
}
function textToMapping(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const [a, b] = line.split("=").map((p) => p.trim());
    if (a && b) out[a] = b;
  }
  return Object.keys(out).length ? out : null;
}

/** The template editor. Every field of `InterviewTemplateSchema` is here; the schema validates on submit. */
export function TemplateForm({
  initial,
  templateId,
  copyFromId,
}: {
  initial: InterviewTemplate;
  templateId?: string | undefined;
  copyFromId?: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const [d, setD] = React.useState<InterviewTemplate>(initial);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [optionsText, setOptionsText] = React.useState<Record<number, string>>(() =>
    Object.fromEntries(initial.contextBlock.map((q, i) => [i, optionsToText(q.options)])),
  );
  const [mappingText, setMappingText] = React.useState(mappingToText(initial.chainMapping));
  const action = useAction();
  const patch = (p: Partial<InterviewTemplate>): void => {
    setD((prev) => ({ ...prev, ...p }));
  };

  const submit = (): void => {
    const candidate: InterviewTemplate = {
      ...d,
      contextBlock: d.contextBlock.map((q, i) => {
        const text = optionsText[i];
        const opts = text === undefined ? q.options : textToOptions(text);
        return opts ? { ...q, options: opts } : { ...q, options: undefined };
      }),
      chainToKey: d.chainToKey?.trim() ? d.chainToKey.trim() : null,
      chainMapping: textToMapping(mappingText),
    };
    const parsed = InterviewTemplateSchema.safeParse(candidate);
    if (!parsed.success) {
      const map: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join(".");
        if (!(path in map)) map[path] = issue.message;
      }
      setErrors(map);
      action.setFlash({ kind: "error", text: s.validation });
      return;
    }
    setErrors({});
    void action.run(async () => {
      const saved = templateId
        ? await staffClient.templates.update(templateId, parsed.data)
        : await staffClient.templates.create(parsed.data, copyFromId);
      router.push(`/admin/templates/${saved.id}`);
      router.refresh();
    });
  };

  const err = (path: string): string | undefined => errors[path];

  return (
    <form
      className="grid gap-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Flash flash={action.flash} />

      <FormSection title={s.sections.basics}>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id="key"
            label={f.key}
            value={d.key}
            hint={f.keyHint}
            error={err("key")}
            onChange={(v) => {
              patch({ key: v });
            }}
          />
          <TextField
            id="name"
            label={f.name}
            value={d.name}
            error={err("name")}
            onChange={(v) => {
              patch({ name: v });
            }}
          />
          <TextField
            id="language"
            label={f.language}
            value={d.language}
            error={err("language")}
            onChange={(v) => {
              patch({ language: v });
            }}
          />
          <SelectField
            id="privacyMode"
            label={f.privacyMode}
            value={d.privacyMode}
            error={err("privacyMode")}
            options={(["identified", "anonymous", "participant_choice"] as const).map((v) => ({
              value: v,
              label: f.privacy[v],
            }))}
            onChange={(v) => {
              patch({ privacyMode: v });
            }}
          />
        </div>
        <TextAreaField
          id="objective"
          label={f.objective}
          value={d.objective}
          hint={f.objectiveHint}
          error={err("objective")}
          rows={3}
          onChange={(v) => {
            patch({ objective: v });
          }}
        />
      </FormSection>

      <FormSection title={s.sections.participants}>
        <SelectField
          id="pathSelection"
          label={f.pathSelection}
          value={d.pathSelection}
          options={(["none", "technical_or_not"] as const).map((v) => ({
            value: v,
            label: f.pathSelectionOptions[v],
          }))}
          onChange={(v) => {
            patch({ pathSelection: v });
          }}
        />
        <div>
          <p className="mb-1 text-sm font-medium">{f.participantFields}</p>
          <p className="text-muted-foreground mb-3 text-xs">{f.participantFieldsHint}</p>
          {err("participantFields") ? (
            <p className="text-destructive mb-2 text-xs">{err("participantFields")}</p>
          ) : null}
          <ListEditor<ParticipantField>
            items={d.participantFields}
            onChange={(items) => {
              patch({ participantFields: items });
            }}
            create={() => ({ key: "", label: "", required: false })}
            addLabel={t.app.add}
            itemLabel={(it) => it.label || it.key || t.admin.common.unnamed}
            renderItem={(it, update, i) => (
              <div className="grid gap-3 md:grid-cols-3">
                <TextField
                  id={`pf-${i}-key`}
                  label={f.fieldKey}
                  value={it.key}
                  error={err(`participantFields.${i}.key`)}
                  onChange={(v) => {
                    update({ key: v });
                  }}
                />
                <TextField
                  id={`pf-${i}-label`}
                  label={f.fieldLabel}
                  value={it.label}
                  error={err(`participantFields.${i}.label`)}
                  onChange={(v) => {
                    update({ label: v });
                  }}
                />
                <div className="pt-6">
                  <SwitchField
                    id={`pf-${i}-required`}
                    label={f.fieldRequired}
                    checked={it.required}
                    onChange={(v) => {
                      update({ required: v });
                    }}
                  />
                </div>
              </div>
            )}
          />
        </div>
      </FormSection>

      <FormSection title={s.sections.context}>
        <p className="text-muted-foreground -mt-2 text-xs">{f.contextBlockHint}</p>
        <ListEditor<ContextQuestion>
          items={d.contextBlock}
          onChange={(items) => {
            patch({ contextBlock: items });
          }}
          create={() => ({ key: "", question: "", why: "" })}
          addLabel={t.app.add}
          itemLabel={(it) => it.question || it.key || t.admin.common.unnamed}
          renderItem={(it, update, i) => (
            <div className="grid gap-3">
              <div className="grid gap-3 md:grid-cols-2">
                <TextField
                  id={`cq-${i}-key`}
                  label={f.contextKey}
                  value={it.key}
                  error={err(`contextBlock.${i}.key`)}
                  onChange={(v) => {
                    update({ key: v });
                  }}
                />
                <TextField
                  id={`cq-${i}-default`}
                  label={f.contextDefault}
                  value={it.default ?? ""}
                  onChange={(v) => {
                    update({ default: v || undefined });
                  }}
                />
              </div>
              <TextField
                id={`cq-${i}-q`}
                label={f.contextQuestion}
                value={it.question}
                error={err(`contextBlock.${i}.question`)}
                onChange={(v) => {
                  update({ question: v });
                }}
              />
              <TextField
                id={`cq-${i}-qn`}
                label={f.contextQuestionNontechnical}
                value={it.questionNontechnical ?? ""}
                onChange={(v) => {
                  update({ questionNontechnical: v || undefined });
                }}
              />
              <TextField
                id={`cq-${i}-why`}
                label={f.contextWhy}
                value={it.why}
                onChange={(v) => {
                  update({ why: v });
                }}
              />
              <TextAreaField
                id={`cq-${i}-options`}
                label={f.contextOptions}
                value={optionsText[i] ?? optionsToText(it.options)}
                onChange={(v) => {
                  setOptionsText((prev) => ({ ...prev, [i]: v }));
                }}
              />
            </div>
          )}
        />
      </FormSection>

      <FormSection title={s.sections.areas}>
        <p className="text-muted-foreground -mt-2 text-xs">{f.coverageAreasHint}</p>
        {err("coverageAreas") ? (
          <p className="text-destructive text-xs" role="alert">
            {err("coverageAreas")}
          </p>
        ) : null}
        <ListEditor<CoverageArea>
          items={d.coverageAreas}
          onChange={(items) => {
            patch({ coverageAreas: items });
          }}
          create={() => ({
            key: "",
            name: "",
            description: "",
            doneWhen: "",
            instructions: "",
            maxFollowUps: 3,
            essential: false,
          })}
          addLabel={t.app.add}
          itemLabel={(it) => it.name || it.key || t.admin.common.unnamed}
          renderItem={(it, update, i) => (
            <div className="grid gap-3">
              <div className="grid gap-3 md:grid-cols-2">
                <TextField
                  id={`ca-${i}-key`}
                  label={f.areaKey}
                  value={it.key}
                  error={err(`coverageAreas.${i}.key`)}
                  onChange={(v) => {
                    update({ key: v });
                  }}
                />
                <TextField
                  id={`ca-${i}-name`}
                  label={f.areaName}
                  value={it.name}
                  error={err(`coverageAreas.${i}.name`)}
                  onChange={(v) => {
                    update({ name: v });
                  }}
                />
              </div>
              <TextAreaField
                id={`ca-${i}-desc`}
                label={f.areaDescription}
                value={it.description}
                error={err(`coverageAreas.${i}.description`)}
                rows={2}
                onChange={(v) => {
                  update({ description: v });
                }}
              />
              <TextAreaField
                id={`ca-${i}-done`}
                label={f.areaDoneWhen}
                value={it.doneWhen}
                error={err(`coverageAreas.${i}.doneWhen`)}
                rows={2}
                onChange={(v) => {
                  update({ doneWhen: v });
                }}
              />
              <TextAreaField
                id={`ca-${i}-instr`}
                label={f.areaInstructions}
                value={it.instructions}
                rows={2}
                onChange={(v) => {
                  update({ instructions: v });
                }}
              />
              <div className="grid gap-3 md:grid-cols-3">
                <NumberField
                  id={`ca-${i}-fu`}
                  label={f.areaMaxFollowUps}
                  value={it.maxFollowUps}
                  min={0}
                  max={10}
                  error={err(`coverageAreas.${i}.maxFollowUps`)}
                  onChange={(v) => {
                    update({ maxFollowUps: v === "" ? 0 : v });
                  }}
                />
                <div className="pt-6">
                  <SwitchField
                    id={`ca-${i}-ess`}
                    label={f.areaEssential}
                    checked={it.essential}
                    onChange={(v) => {
                      update({ essential: v });
                    }}
                  />
                </div>
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">{f.areaPaths}</legend>
                  {(["technical", "nontechnical"] as const).map((p) => {
                    const checked = it.paths?.includes(p) ?? false;
                    return (
                      <label key={p} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => {
                            const cur = new Set(it.paths ?? []);
                            if (v === true) cur.add(p);
                            else cur.delete(p);
                            update({ paths: cur.size ? [...cur] : undefined });
                          }}
                        />
                        {t.participant.path[p]}
                      </label>
                    );
                  })}
                  <span className="text-muted-foreground text-xs">
                    {!it.paths?.length ? f.areaPathsBoth : ""}
                  </span>
                </fieldset>
              </div>
            </div>
          )}
        />
      </FormSection>

      <FormSection title={s.sections.ai}>
        <TextAreaField
          id="aiInstructions"
          label={f.aiInstructions}
          value={d.aiInstructions}
          hint={f.aiInstructionsHint}
          rows={6}
          onChange={(v) => {
            patch({ aiInstructions: v });
          }}
        />
      </FormSection>

      <FormSection title={s.sections.adaptivity}>
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            id="followUpPolicy"
            label={f.followUpPolicy}
            value={d.adaptivity.followUpPolicy}
            options={(["clarify_ambiguous_and_deepen_processes", "clarify_only", "none"] as const).map(
              (v) => ({ value: v, label: f.followUpPolicyOptions[v] }),
            )}
            onChange={(v) => {
              patch({ adaptivity: { ...d.adaptivity, followUpPolicy: v } });
            }}
          />
          <NumberField
            id="minimalAnswerThreshold"
            label={f.minimalAnswerThreshold}
            value={d.adaptivity.minimalAnswerThreshold}
            min={1}
            max={10}
            error={err("adaptivity.minimalAnswerThreshold")}
            onChange={(v) => {
              patch({ adaptivity: { ...d.adaptivity, minimalAnswerThreshold: v === "" ? 1 : v } });
            }}
          />
        </div>
        <SwitchField
          id="offerPathSwitch"
          label={f.offerPathSwitch}
          checked={d.adaptivity.offerPathSwitch}
          onChange={(v) => {
            patch({ adaptivity: { ...d.adaptivity, offerPathSwitch: v } });
          }}
        />
        <SwitchField
          id="toneByRole"
          label={f.toneByRole}
          checked={d.adaptivity.toneByRole}
          onChange={(v) => {
            patch({ adaptivity: { ...d.adaptivity, toneByRole: v } });
          }}
        />
      </FormSection>

      <FormSection title={s.sections.widgets}>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{f.allowedWidgetTypes}</legend>
          <div className="flex flex-wrap gap-4">
            {WIDGET_TYPES.map((w) => (
              <label key={w} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={d.widgetPolicy.allowedTypes.includes(w)}
                  onCheckedChange={(v) => {
                    const cur = new Set(d.widgetPolicy.allowedTypes);
                    if (v === true) cur.add(w);
                    else cur.delete(w);
                    patch({
                      widgetPolicy: {
                        ...d.widgetPolicy,
                        allowedTypes: WIDGET_TYPES.filter((x) => cur.has(x)),
                      },
                    });
                  }}
                />
                {s.widgetTypes[w]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 md:grid-cols-2">
          <NumberField
            id="widgetMaxPerTurns"
            label={f.widgetMaxPerTurns}
            value={d.widgetPolicy.maxPerTurns}
            min={0}
            max={10}
            error={err("widgetPolicy.maxPerTurns")}
            onChange={(v) => {
              patch({ widgetPolicy: { ...d.widgetPolicy, maxPerTurns: v === "" ? 0 : v } });
            }}
          />
          <NumberField
            id="widgetEveryTurns"
            label={f.widgetEveryTurns}
            value={d.widgetPolicy.everyTurns}
            min={1}
            max={10}
            error={err("widgetPolicy.everyTurns")}
            onChange={(v) => {
              patch({ widgetPolicy: { ...d.widgetPolicy, everyTurns: v === "" ? 1 : v } });
            }}
          />
        </div>
      </FormSection>

      <FormSection title={s.sections.issues}>
        <SwitchField
          id="issueEnabled"
          label={f.issueEnabled}
          checked={d.issueDetection.enabled}
          onChange={(v) => {
            patch({ issueDetection: { ...d.issueDetection, enabled: v } });
          }}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <NumberField
            id="issueEveryTurns"
            label={f.issueEveryTurns}
            value={d.issueDetection.everyTurns}
            min={1}
            max={20}
            error={err("issueDetection.everyTurns")}
            onChange={(v) => {
              patch({ issueDetection: { ...d.issueDetection, everyTurns: v === "" ? 1 : v } });
            }}
          />
          <SelectField
            id="issueAggressiveness"
            label={f.issueAggressiveness}
            value={d.issueDetection.aggressiveness}
            options={(["gentle", "standard", "strict"] as const).map((v) => ({ value: v, label: v }))}
            onChange={(v) => {
              patch({ issueDetection: { ...d.issueDetection, aggressiveness: v } });
            }}
          />
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{f.issueTypes}</legend>
          <div className="flex flex-wrap gap-4">
            {ISSUE_TYPES.map((it) => (
              <label key={it} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={d.issueDetection.typesEnabled.includes(it)}
                  onCheckedChange={(v) => {
                    const cur = new Set<IssueType>(d.issueDetection.typesEnabled);
                    if (v === true) cur.add(it);
                    else cur.delete(it);
                    patch({
                      issueDetection: {
                        ...d.issueDetection,
                        typesEnabled: ISSUE_TYPES.filter((x) => cur.has(x)),
                      },
                    });
                  }}
                />
                {it.replace("_", " ")}
              </label>
            ))}
          </div>
        </fieldset>
        <SwitchField
          id="issuePushBackOnce"
          label={f.issuePushBackOnce}
          checked={d.issueDetection.pushBackOnce}
          onChange={(v) => {
            patch({ issueDetection: { ...d.issueDetection, pushBackOnce: v } });
          }}
        />
        <SwitchField
          id="issueMvpChallenge"
          label={f.issueMvpChallenge}
          checked={d.issueDetection.mvpChallenge}
          onChange={(v) => {
            patch({ issueDetection: { ...d.issueDetection, mvpChallenge: v } });
          }}
        />
      </FormSection>

      <FormSection title={s.sections.outputs}>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{f.outputs}</legend>
          {err("outputs") ? (
            <p className="text-destructive text-xs" role="alert">
              {err("outputs")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-4">
            {FACT_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={d.outputs.includes(k)}
                  onCheckedChange={(v) => {
                    const cur = new Set(d.outputs);
                    if (v === true) cur.add(k);
                    else cur.delete(k);
                    patch({ outputs: FACT_KINDS.filter((x) => cur.has(x)) });
                  }}
                />
                {s.factKinds[k]}
              </label>
            ))}
          </div>
        </fieldset>
        <SwitchField
          id="analysisEnabled"
          label={f.analysisEnabled}
          checked={d.analysisEnabled}
          onChange={(v) => {
            patch({ analysisEnabled: v });
          }}
        />
      </FormSection>

      <FormSection title={s.sections.chaining}>
        <TextField
          id="chainToKey"
          label={f.chainToKey}
          value={d.chainToKey ?? ""}
          hint={f.chainToKeyHint}
          onChange={(v) => {
            patch({ chainToKey: v });
          }}
        />
        <Field id="chainMapping" label={f.chainMapping}>
          <textarea
            id="chainMapping"
            value={mappingText}
            rows={4}
            className="border-input min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            onChange={(e) => {
              setMappingText(e.target.value);
            }}
          />
        </Field>
      </FormSection>

      <FormSection title={s.sections.closing}>
        <TextField
          id="closingQuestion"
          label={f.closingQuestion}
          value={d.closingQuestion}
          onChange={(v) => {
            patch({ closingQuestion: v });
          }}
        />
        <SwitchField
          id="endSummary"
          label={f.endSummary}
          checked={d.endSummary}
          onChange={(v) => {
            patch({ endSummary: v });
          }}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <NumberField
            id="maxTurns"
            label={f.maxTurns}
            value={d.maxTurns}
            min={5}
            max={500}
            error={err("maxTurns")}
            onChange={(v) => {
              patch({ maxTurns: v === "" ? 5 : v });
            }}
          />
          <NumberField
            id="maxAssistantChars"
            label={f.maxAssistantChars}
            value={d.maxAssistantChars}
            min={100}
            max={4000}
            error={err("maxAssistantChars")}
            onChange={(v) => {
              patch({ maxAssistantChars: v === "" ? 100 : v });
            }}
          />
        </div>
      </FormSection>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={action.busy}>
          {action.busy ? t.app.saving : templateId ? s.saveVersion : t.app.create}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            router.back();
          }}
        >
          {t.app.cancel}
        </Button>
        <Label className="text-muted-foreground text-xs font-normal">v{d.version}</Label>
      </div>
    </form>
  );
}
