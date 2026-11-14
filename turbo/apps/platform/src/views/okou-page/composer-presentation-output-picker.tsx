import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  PRESENTATION_OUTPUT_FORMATS,
  presentationOutputFormat$,
  presentationOutputFormatEnabled$,
  setPresentationOutputFormat$,
} from "../../signals/okou-page/presentation-output-format.ts";
import { ComposerOutputPicker } from "./composer-output-picker.tsx";

export function ComposerPresentationOutputPicker({
  nested = false,
}: {
  readonly nested?: boolean;
}) {
  const { t } = useTranslation();
  const enabled = useGet(presentationOutputFormatEnabled$);
  const format = useGet(presentationOutputFormat$);
  const setFormat = useSet(setPresentationOutputFormat$);
  const formats = t(
    ($) => {
      return $.chat.taskChips.presentationFormats;
    },
    { returnObjects: true },
  );
  if (!enabled) {
    return null;
  }
  return (
    <ComposerOutputPicker
      label={t(($) => {
        return nested
          ? $.chat.taskChips.presentationFormat
          : $.chat.taskChips.visualization.outputFormat;
      })}
      options={PRESENTATION_OUTPUT_FORMATS.map((value) => {
        return { value, label: formats[value] };
      })}
      selectedValue={format}
      onSelect={setFormat}
    />
  );
}
