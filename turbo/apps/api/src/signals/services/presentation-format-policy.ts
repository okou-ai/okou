import { v5 as uuidv5 } from "uuid";

/** One accepted selection input per originating Run, independent of the choice. */
export function presentationFormatContinuationEventId(
  sourceRunId: string,
): string {
  return uuidv5("presentation-format-selection:v1", sourceRunId);
}

/** Publication rolled back because the source or current default changed. */
export class PresentationFormatPublicationConflict extends Error {
  constructor() {
    super("Presentation format selection is no longer available");
  }
}
