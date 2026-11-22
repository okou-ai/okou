import type { PresentationOutputFormat } from "./presentation-output-format";
import { findPresentationRunbookPackage } from "./resource-registry";

/** Rewrite only a built-in package whose requested native format actually exists. */
export function withPresentationTemplateFormat<
  Selection extends {
    readonly templateId: string;
    readonly outputFormat?: PresentationOutputFormat;
  },
>(
  selection: Selection,
  outputFormat: PresentationOutputFormat,
): Selection | null {
  return findPresentationRunbookPackage(selection.templateId, outputFormat)
    ? { ...selection, outputFormat }
    : null;
}
