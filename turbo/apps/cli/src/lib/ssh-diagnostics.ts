import { z } from "zod";

/** The explanation belongs to Runner; only text size and terminal safety matter here. */
export const diagnosticTextSchema = z
  .unknown()
  .transform((value) => {
    if (
      typeof value === "string" &&
      Buffer.byteLength(value) <= 8192 &&
      ![...value].some((char) => {
        const code = char.codePointAt(0);
        return (
          code !== undefined &&
          ((code < 32 && code !== 9 && code !== 10) ||
            (code >= 127 && code <= 159))
        );
      })
    )
      return value;
    return undefined;
  })
  .optional();

export function printSshDiagnostics(result: {
  type: string;
  diagnostic_text?: string;
}) {
  if (result.diagnostic_text) console.error(result.diagnostic_text);
}
