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

/** This marker comes from the owning Runner, alongside its bundled helper.
 * Older Runners omit it; older CLIs never request extra result fields.
 * Keep the absent-marker path until captured CLI/Runner consumers and retained
 * rollback builds have drained; #40283 owns that compatibility removal review. */
export function diagnosticParams(params: Readonly<Record<string, unknown>>) {
  return process.env.OKOU_REMOTE_DIAGNOSTIC_TEXT === "1"
    ? { ...params, diagnosticText: true }
    : params;
}

export function printSshDiagnostics(result: {
  type: string;
  diagnostic_text?: string;
}) {
  if (result.diagnostic_text) console.error(result.diagnostic_text);
}
