import { t } from "@/i18n";
import { issueMessage, type FormIssue } from "@/lib/admin/validation";

/** Ids of the template editor's sections; stable, unlike the localized titles. */
export const TEMPLATE_SECTIONS = [
  "basics",
  "participants",
  "context",
  "areas",
  "ai",
  "adaptivity",
  "widgets",
  "issues",
  "outputs",
  "chaining",
  "closing",
] as const;
export type TemplateSection = (typeof TEMPLATE_SECTIONS)[number];

interface Place {
  section: TemplateSection;
  /** DOM id of the field; falls back to the section's own id when the field has none. */
  id: string;
  /** The label of the field, without the section. */
  field: string;
  /** Which list item (1-based), when the path goes through a list. */
  item?: number;
}

type Path = readonly (string | number)[];

const ROOT: Record<string, { section: TemplateSection; id?: string }> = {
  key: { section: "basics" },
  name: { section: "basics" },
  language: { section: "basics" },
  objective: { section: "basics" },
  privacyMode: { section: "basics" },
  pathSelection: { section: "participants" },
  participantFields: { section: "participants" },
  contextBlock: { section: "context" },
  coverageAreas: { section: "areas" },
  aiInstructions: { section: "ai" },
  adaptivity: { section: "adaptivity" },
  widgetPolicy: { section: "widgets" },
  issueDetection: { section: "issues" },
  outputs: { section: "outputs" },
  analysisEnabled: { section: "outputs" },
  chainToKey: { section: "chaining" },
  chainMapping: { section: "chaining" },
  closingQuestion: { section: "closing" },
  endSummary: { section: "closing" },
  maxTurns: { section: "closing" },
  maxAssistantChars: { section: "closing" },
};

/** Field ids inside a list item, by list. The ids are the ones `TemplateForm` renders. */
const ITEM_IDS: Record<string, Record<string, { id: string; label: () => string }>> = {
  participantFields: {
    key: { id: "pf-$-key", label: () => t.admin.templates.fields.fieldKey },
    label: { id: "pf-$-label", label: () => t.admin.templates.fields.fieldLabel },
    required: { id: "pf-$-required", label: () => t.admin.templates.fields.fieldRequired },
  },
  contextBlock: {
    key: { id: "cq-$-key", label: () => t.admin.templates.fields.contextKey },
    question: { id: "cq-$-q", label: () => t.admin.templates.fields.contextQuestion },
    questionNontechnical: {
      id: "cq-$-qn",
      label: () => t.admin.templates.fields.contextQuestionNontechnical,
    },
    why: { id: "cq-$-why", label: () => t.admin.templates.fields.contextWhy },
    default: { id: "cq-$-default", label: () => t.admin.templates.fields.contextDefault },
    options: { id: "cq-$-options", label: () => t.admin.templates.fields.contextOptions },
  },
  coverageAreas: {
    key: { id: "ca-$-key", label: () => t.admin.templates.fields.areaKey },
    name: { id: "ca-$-name", label: () => t.admin.templates.fields.areaName },
    description: { id: "ca-$-desc", label: () => t.admin.templates.fields.areaDescription },
    doneWhen: { id: "ca-$-done", label: () => t.admin.templates.fields.areaDoneWhen },
    instructions: { id: "ca-$-instr", label: () => t.admin.templates.fields.areaInstructions },
    maxFollowUps: { id: "ca-$-fu", label: () => t.admin.templates.fields.areaMaxFollowUps },
    essential: { id: "ca-$-ess", label: () => t.admin.templates.fields.areaEssential },
  },
};

const NESTED: Record<string, Record<string, { id: string; label: () => string }>> = {
  adaptivity: {
    followUpPolicy: { id: "followUpPolicy", label: () => t.admin.templates.fields.followUpPolicy },
    minimalAnswerThreshold: {
      id: "minimalAnswerThreshold",
      label: () => t.admin.templates.fields.minimalAnswerThreshold,
    },
    offerPathSwitch: { id: "offerPathSwitch", label: () => t.admin.templates.fields.offerPathSwitch },
    toneByRole: { id: "toneByRole", label: () => t.admin.templates.fields.toneByRole },
  },
  widgetPolicy: {
    maxPerTurns: { id: "widgetMaxPerTurns", label: () => t.admin.templates.fields.widgetMaxPerTurns },
    everyTurns: { id: "widgetEveryTurns", label: () => t.admin.templates.fields.widgetEveryTurns },
    allowedTypes: { id: "section-widgets", label: () => t.admin.templates.fields.allowedWidgetTypes },
  },
  issueDetection: {
    enabled: { id: "issueEnabled", label: () => t.admin.templates.fields.issueEnabled },
    everyTurns: { id: "issueEveryTurns", label: () => t.admin.templates.fields.issueEveryTurns },
    aggressiveness: {
      id: "issueAggressiveness",
      label: () => t.admin.templates.fields.issueAggressiveness,
    },
    typesEnabled: { id: "section-issues", label: () => t.admin.templates.fields.issueTypes },
    pushBackOnce: { id: "issuePushBackOnce", label: () => t.admin.templates.fields.issuePushBackOnce },
    mvpChallenge: { id: "issueMvpChallenge", label: () => t.admin.templates.fields.issueMvpChallenge },
  },
};

const ROOT_LABEL: Record<string, () => string> = {
  key: () => t.admin.templates.fields.key,
  name: () => t.admin.templates.fields.name,
  language: () => t.admin.templates.fields.language,
  objective: () => t.admin.templates.fields.objective,
  privacyMode: () => t.admin.templates.fields.privacyMode,
  pathSelection: () => t.admin.templates.fields.pathSelection,
  participantFields: () => t.admin.templates.fields.participantFields,
  contextBlock: () => t.admin.templates.fields.contextBlock,
  coverageAreas: () => t.admin.templates.fields.coverageAreas,
  aiInstructions: () => t.admin.templates.fields.aiInstructions,
  outputs: () => t.admin.templates.fields.outputs,
  analysisEnabled: () => t.admin.templates.fields.analysisEnabled,
  chainToKey: () => t.admin.templates.fields.chainToKey,
  chainMapping: () => t.admin.templates.fields.chainMapping,
  closingQuestion: () => t.admin.templates.fields.closingQuestion,
  endSummary: () => t.admin.templates.fields.endSummary,
  maxTurns: () => t.admin.templates.fields.maxTurns,
  maxAssistantChars: () => t.admin.templates.fields.maxAssistantChars,
};

/** Maps a zod issue path of the template schema to the field the editor renders for it. */
export function locateTemplateIssue(path: Path): Place {
  const root = String(path[0] ?? "");
  const section = ROOT[root]?.section ?? "basics";
  const sectionId = `section-${section}`;
  const rootLabel = ROOT_LABEL[root]?.() ?? root;

  const items = ITEM_IDS[root];
  if (items && typeof path[1] === "number") {
    const index = path[1];
    const leaf = items[String(path[2] ?? "")];
    return {
      section,
      id: leaf ? leaf.id.replace("$", String(index)) : sectionId,
      field: leaf ? leaf.label() : rootLabel,
      item: index + 1,
    };
  }
  const nested = NESTED[root];
  if (nested) {
    const leaf = nested[String(path[1] ?? "")];
    if (leaf) return { section, id: leaf.id, field: leaf.label() };
    return { section, id: sectionId, field: rootLabel };
  }
  // A top-level field whose control has the field's own name as id; the rest point at the section.
  const direct = new Set([
    "key",
    "name",
    "language",
    "objective",
    "privacyMode",
    "pathSelection",
    "aiInstructions",
    "analysisEnabled",
    "chainToKey",
    "chainMapping",
    "closingQuestion",
    "endSummary",
    "maxTurns",
    "maxAssistantChars",
  ]);
  return { section, id: direct.has(root) ? root : sectionId, field: rootLabel };
}

/** Turns zod issues into the list the summary shows, one entry per field, first message wins. */
export function templateIssues(
  issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[],
): FormIssue[] {
  const seen = new Set<string>();
  const out: FormIssue[] = [];
  const s = t.admin.templates;
  for (const issue of issues) {
    const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
    const place = locateTemplateIssue(path);
    const key = `${place.id}:${path.join(".")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const where = s.sections[place.section];
    const field = place.item === undefined ? place.field : `${place.field} ${place.item}`;
    out.push({
      id: place.id,
      label: `${where}: ${field}`,
      message: issueMessage(issue),
      section: place.section,
    });
  }
  return out;
}
