"use client";

import type { Widget, WidgetResponse } from "@aidp/shared";
import * as React from "react";
import { MultiChoiceWidget } from "./MultiChoiceWidget";
import { RankingWidget } from "./RankingWidget";
import { ScaleWidget } from "./ScaleWidget";
import { SingleChoiceWidget } from "./SingleChoiceWidget";
import { YesNoWidget } from "./YesNoWidget";

export interface WidgetRendererProps {
  widget: Widget;
  disabled?: boolean | undefined;
  onSubmit: (response: WidgetResponse) => void;
}

/** Renders the widget of an interviewer turn. The participant may always ignore it and type instead. */
export function WidgetRenderer({ widget, disabled, onSubmit }: WidgetRendererProps): React.JSX.Element {
  switch (widget.type) {
    case "single_choice":
      return <SingleChoiceWidget widget={widget} disabled={disabled} onSubmit={onSubmit} />;
    case "multi_choice":
      return <MultiChoiceWidget widget={widget} disabled={disabled} onSubmit={onSubmit} />;
    case "scale":
      return <ScaleWidget widget={widget} disabled={disabled} onSubmit={onSubmit} />;
    case "ranking":
      return <RankingWidget widget={widget} disabled={disabled} onSubmit={onSubmit} />;
    case "yes_no":
      return <YesNoWidget widget={widget} disabled={disabled} onSubmit={onSubmit} />;
  }
}
