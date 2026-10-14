"use client";

import * as React from "react";

type Labels = Record<string, string>;

interface CrumbStore {
  labels: Labels;
  set: (labels: Labels) => void;
}

const CrumbContext = React.createContext<CrumbStore>({ labels: {}, set: () => undefined });

/**
 * Carries the names of the id segments of the URL from the page (which knows them) to the top bar
 * (which draws the trail). A page declares them through `PageHeader`'s `crumbLabels`.
 */
export function CrumbProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [labels, setLabels] = React.useState<Labels>({});
  const value = React.useMemo<CrumbStore>(() => ({ labels, set: setLabels }), [labels]);
  return <CrumbContext.Provider value={value}>{children}</CrumbContext.Provider>;
}

export function useCrumbLabels(): Labels {
  return React.useContext(CrumbContext).labels;
}

/** Renders nothing; publishes `labels` to the trail while the page is mounted. */
export function CrumbLabels({ labels }: { labels: Labels | undefined }): null {
  const { set } = React.useContext(CrumbContext);
  const key = JSON.stringify(labels ?? {});
  React.useEffect(() => {
    set(JSON.parse(key) as Labels);
    return () => {
      set({});
    };
  }, [key, set]);
  return null;
}
