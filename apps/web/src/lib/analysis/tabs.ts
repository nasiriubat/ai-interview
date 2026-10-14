/** The sections of the results workspace; the address carries the one on screen as `?tab=` (D-372). */
export const RESULTS_TABS = ["overview", "opportunities", "departments", "history"] as const;
export type ResultsTab = (typeof RESULTS_TABS)[number];
