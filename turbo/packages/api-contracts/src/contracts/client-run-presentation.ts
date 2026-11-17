import type { LogDetail } from "./logs";

export type ClientLogDetail = Omit<LogDetail, "error">;

/** Keep the old HTTP response intact while excluding diagnostics from business state. */
export function logDetailForDisplay(detail: LogDetail): ClientLogDetail {
  const displayed = { ...detail };
  delete displayed.error;
  return displayed;
}
