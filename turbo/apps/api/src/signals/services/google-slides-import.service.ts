import { logger } from "../../lib/log";
import {
  prepareGoogleSlides,
  type SlidesTextStyle,
} from "./google-slides-preparation";

export type { SlidesTextStyle };

const log = logger("api:google-slides-import");

export function prepareGoogleSlidesImport(
  source: { readonly filename: string; readonly file: Buffer },
  signal: AbortSignal,
): ReturnType<typeof prepareGoogleSlides> {
  return prepareGoogleSlides(
    source,
    (message, fields) => {
      log.warn(message, fields);
    },
    signal,
  );
}
