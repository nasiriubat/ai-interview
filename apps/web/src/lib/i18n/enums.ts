import {
  AGGRESSIVENESS,
  FACT_KINDS,
  FACTOR_KEYS,
  FINDING_STATUSES,
  FINDING_TYPES,
  InterviewTemplateSchema,
  PROVIDER_KINDS,
  PURPOSES,
  REPORT_SECTIONS,
  SETTING_SCOPES,
  SOLUTION_CLASSES,
  SPEC_SECTION_KEYS,
  WIDGET_TYPES,
  BudgetScopeSchema,
  CallStatusSchema,
  EffortSchema,
  OpportunityStatusSchema,
  PrivacyModeSchema,
  PathSelectionSchema,
  SpecVersionStatusSchema,
  CoverageStatusSchema,
} from "@aidp/shared";
import { currentLocale, DICTIONARIES, t, type Locale, type Strings } from "@/i18n";

/*
 * One place that turns an identifier from the API or the shared packages into words.
 *
 * Why not `humanize()`: it spells the identifier out in English whatever the language, and a
 * label such as "Interview turn" is not the name an admin knows the task by. Every kind below
 * points at a table in the locale files, and `test/enums.test.ts` fails when a member of the
 * shared enum has no label in a language (D-132).
 *
 * An identifier nobody has named yet (a newer API, a status added later) comes back as itself:
 * `label` returns it unchanged and `EnumLabel` shows it as code, so it is never silently
 * reworded into something that looks translated.
 */

type Source = (s: Strings) => Readonly<Record<string, string>>;

interface EnumDef {
  /** The shared members that must each have a label; empty where the set is open-ended. */
  members: readonly string[];
  source: Source;
}

const def = (source: Source, members: readonly string[] = []): EnumDef => ({ members, source });

const TEMPLATE_FIELDS = Object.keys(InterviewTemplateSchema.shape).filter(
  (k) => k !== "key" && k !== "version",
);

export const ENUMS = {
  purpose: def((s) => s.enums.purpose, PURPOSES),
  providerKind: def((s) => s.enums.providerKind, PROVIDER_KINDS),
  effort: def((s) => s.enums.effort, EffortSchema.options),
  aggressiveness: def((s) => s.enums.aggressiveness, [...AGGRESSIVENESS, "template"]),
  budgetScope: def((s) => s.enums.budgetScope, BudgetScopeSchema.options),
  budgetPeriod: def((s) => s.enums.budgetPeriod, ["month", "total"]),
  specScope: def((s) => s.enums.specScope, ["mvp", "future"]),
  callStatus: def((s) => s.enums.callStatus, CallStatusSchema.options),
  settingScope: def((s) => s.admin.settings.scopes, SETTING_SCOPES),
  solutionClass: def((s) => s.admin.results.classes, SOLUTION_CLASSES),
  opportunityStatus: def((s) => s.admin.results.statuses, OpportunityStatusSchema.options),
  findingType: def((s) => s.admin.requirements.findings.types, FINDING_TYPES),
  findingStatus: def((s) => s.admin.requirements.findings.statuses, FINDING_STATUSES),
  specVersionStatus: def((s) => s.admin.requirements.versions.statuses, SpecVersionStatusSchema.options),
  specSection: def((s) => s.admin.requirements.sectionNames, SPEC_SECTION_KEYS),
  reportSection: def((s) => s.admin.report.sectionNames, REPORT_SECTIONS),
  factKind: def((s) => s.admin.templates.factKinds, FACT_KINDS),
  widgetType: def((s) => s.admin.templates.widgetTypes, WIDGET_TYPES),
  privacyMode: def((s) => s.admin.templates.fields.privacy, PrivacyModeSchema.options),
  pathSelection: def((s) => s.admin.templates.fields.pathSelectionOptions, PathSelectionSchema.options),
  factor: def((s) => s.admin.results.factors, FACTOR_KEYS),
  coverageStatus: def((s) => s.participant.session.progressStatus, CoverageStatusSchema.options),
  templateField: def((s) => s.enums.templateField, TEMPLATE_FIELDS),
  language: def((s) => s.app.languageNames, ["en", "fi"]),
  /** Template coverage-area keys of the shipped discovery template (a template's own names win). */
  coverageArea: def((s) => s.enums.coverageArea),
  /** Keys of the platform statistics. */
  statKey: def((s) => s.enums.statKey),
  /** Keys of the answers to the requirements template's background questions. */
  contextKey: def((s) => s.enums.contextKey),
  /** Statuses of campaigns, invitations, sessions, templates and jobs; the set grows with the API. */
  status: def((s) => s.admin.list.statuses),
} as const satisfies Record<string, EnumDef>;

export type EnumKind = keyof typeof ENUMS;

/** The label of `value` in a given language, or `undefined` when nobody has named it. */
export function labelIn(strings: Strings, kind: EnumKind, value: string): string | undefined {
  const table = ENUMS[kind].source(strings);
  return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : undefined;
}

/** The label of `value` for the active language; an unnamed identifier is returned as it is. */
export function label(kind: EnumKind, value: string): string {
  return labelIn(DICTIONARIES[currentLocale()], kind, value) ?? value;
}

/** True when `value` has a name in the active language, so a caller can style the fallback. */
export function hasLabel(kind: EnumKind, value: string): boolean {
  return labelIn(DICTIONARIES[currentLocale()], kind, value) !== undefined;
}

export function settingTextIn(
  strings: Strings,
  key: string,
): { label: string; description: string } | undefined {
  const table: Record<string, { label: string; description: string } | undefined> = strings.enums.settingKey;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The name and one-sentence description of a catalog key, or `undefined` for a key we do not know. */
export function settingText(key: string): { label: string; description: string } | undefined {
  return settingTextIn(t, key);
}

export function settingValueLabelIn(strings: Strings, key: string, value: string): string | undefined {
  const table: Record<string, Record<string, string> | undefined> = strings.enums.settingValue;
  const options = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  return options && Object.prototype.hasOwnProperty.call(options, value) ? options[value] : undefined;
}

/** The label of one option of an enum-valued setting, or the value itself when it has none. */
export function settingValueLabel(key: string, value: string): string {
  return settingValueLabelIn(t, key, value) ?? value;
}

export type { Locale };
