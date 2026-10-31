import { command, computed } from "ccstate";
import { array, number, object, string, uuid } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { now } from "../../lib/time.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { hash, pathname, replaceState, search } from "../location.ts";
import { searchParams$ } from "../route.ts";
import { jsonParseOr } from "../utils.ts";
import { landingFileSource } from "./landing-file-handoff.ts";

const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_PREVIEW_LENGTH = 32 * 1024;
const draftIdSchema = uuid();
const filesSchema = array(
  object({
    name: string().min(1).max(1024),
    size: number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
    type: string().max(255),
  }),
)
  .min(1)
  .max(10)
  .refine((files) => {
    return (
      files.reduce((total, file) => {
        return total + file.size;
      }, 0) <=
      1024 * 1024 * 1024
    );
  });
const savedPreviewSchema = object({
  source: string(),
  savedAt: number().finite().nonnegative(),
  files: filesSchema,
});

function previewStorage(id: string) {
  return localStorageSignals(`landing-files:preview:${id}`);
}

/** Metadata is display-only; readLandingFiles remains authoritative for upload. */
export const captureLandingFilePreview$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const fragment = new URLSearchParams(hash().slice(1));
    const raw = fragment.get("landingFilePreview");
    if (raw === null) {
      return;
    }
    fragment.delete("landingFilePreview");
    // Remove names before auth redirects and telemetry, even for invalid input.
    replaceState(
      window.history.state,
      "",
      `${pathname()}${search()}${fragment.size ? `#${fragment}` : ""}`,
    );
    const params = new URLSearchParams(search());
    const id = draftIdSchema.safeParse(params.get("landingFiles"));
    const source = landingFileSource(
      params.get("landingSource") ?? "",
      location.origin,
    );
    if (!id.success || !source || raw.length > MAX_PREVIEW_LENGTH) {
      return;
    }
    const parsed = filesSchema.safeParse(jsonParseOr<unknown>(raw, null));
    if (!parsed.success) {
      return;
    }
    set(
      previewStorage(id.data).set$,
      JSON.stringify({
        source: source.href,
        savedAt: now(),
        files: parsed.data,
      }),
    );
  },
);

const currentPreviewStorage$ = computed((get) => {
  const id = draftIdSchema.safeParse(get(searchParams$).get("landingFiles"));
  return id.success ? previewStorage(id.data) : null;
});

export const landingFilePreview$ = computed(async (get) => {
  const switches = await get(featureSwitch$);
  if (!switches[FeatureSwitchKey.LandingFileHandoff]) {
    return null;
  }
  const source = landingFileSource(
    get(searchParams$).get("landingSource") ?? "",
    location.origin,
  );
  const storage = get(currentPreviewStorage$);
  if (!source || !storage) {
    return null;
  }
  const raw = get(storage.get$);
  const parsed = savedPreviewSchema.safeParse(
    jsonParseOr<unknown>(raw ?? "null", null),
  );
  if (
    !parsed.success ||
    parsed.data.source !== source.href ||
    now() - parsed.data.savedAt > MAX_AGE
  ) {
    return null;
  }
  return parsed.data.files.map((file) => {
    return { id: crypto.randomUUID(), file };
  });
});
