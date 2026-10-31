import { command, computed, state } from "ccstate";
import { array, number, object, string, uuid } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { now } from "../../lib/time.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { hash, pathname, replaceState, search } from "../location.ts";
import { searchParams$ } from "../route.ts";
import { jsonParseOr, onRef } from "../utils.ts";
import { landingFileSource } from "./landing-file-handoff.ts";
import {
  saveLandingFileAdditions,
  removeLandingFileAddition,
} from "./landing-file-store.ts";

const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_PREVIEW_LENGTH = 32 * 1024;
const draftIdSchema = uuid();
const fileSchema = object({
  name: string().min(1).max(1024),
  size: number()
    .int()
    .nonnegative()
    .max(1024 * 1024 * 1024),
  type: string().max(255),
});
const filesSchema = array(fileSchema)
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
  removed: array(number().int().min(0).max(9)).default([]),
  added: array(fileSchema.extend({ key: uuid() }))
    .max(10)
    .default([]),
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

export const landingFileSelection$ = computed((get) => {
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
  return { ...parsed.data, id: get(searchParams$).get("landingFiles") ?? "" };
});

export const landingFilePreview$ = computed(async (get) => {
  const switches = await get(featureSwitch$);
  if (!switches[FeatureSwitchKey.LandingFileHandoff]) {
    return null;
  }
  const selection = get(landingFileSelection$);
  if (!selection) {
    return null;
  }
  return [
    ...selection.files.flatMap((file, index) => {
      return selection.removed.includes(index)
        ? []
        : [{ id: `source-${index}`, file }];
    }),
    ...selection.added.map(({ key, ...file }) => {
      return { id: key, file };
    }),
  ];
});

export class LandingFileLimitError extends Error {}

type LandingFileEdit =
  { kind: "add"; files: File[] } | { kind: "remove"; key: string };
const pendingEdit$ = state<Promise<void> | null>(null);
export const landingFileEditsReady$ = computed((get) => {
  return get(pendingEdit$);
});

const applyLandingFileEdit$ = command(
  async ({ get, set }, edit: LandingFileEdit, signal: AbortSignal) => {
    const previous = get(pendingEdit$);
    if (previous) {
      await Promise.allSettled([previous]);
    }
    signal.throwIfAborted();
    const selection = get(landingFileSelection$);
    const storage = get(currentPreviewStorage$);
    if (!selection || !storage) {
      return;
    }
    if (edit.kind === "remove") {
      if (edit.key.startsWith("source-")) {
        const index = Number(edit.key.slice(7));
        if (Number.isInteger(index) && selection.files[index]) {
          set(
            storage.set$,
            JSON.stringify({
              ...selection,
              removed: [...new Set([...selection.removed, index])],
            }),
          );
        }
      } else {
        await removeLandingFileAddition(selection.id, edit.key, signal);
        signal.throwIfAborted();
        set(
          storage.set$,
          JSON.stringify({
            ...selection,
            added: selection.added.filter((file) => {
              return file.key !== edit.key;
            }),
          }),
        );
      }
      return;
    }
    const retained = selection.files.filter((_file, index) => {
      return !selection.removed.includes(index);
    });
    const next = [...retained, ...selection.added, ...edit.files];
    if (
      next.length > 10 ||
      next.reduce((total, file) => {
        return total + file.size;
      }, 0) >
        1024 * 1024 * 1024
    ) {
      throw new LandingFileLimitError();
    }
    const additions = edit.files.map((file) => {
      return { key: crypto.randomUUID(), file };
    });
    await saveLandingFileAdditions(selection.id, additions, signal);
    signal.throwIfAborted();
    set(
      storage.set$,
      JSON.stringify({
        ...selection,
        added: [
          ...selection.added,
          ...additions.map(({ key, file }) => {
            return { key, name: file.name, size: file.size, type: file.type };
          }),
        ],
      }),
    );
  },
);

export const editLandingFiles$ = command(
  ({ set }, edit: LandingFileEdit, signal: AbortSignal) => {
    const pending = set(applyLandingFileEdit$, edit, signal);
    set(pendingEdit$, pending);
    return pending;
  },
);

const fileInput$ = state<HTMLInputElement | null>(null);
export const setLandingFileInput$ = onRef(
  command(({ set }, element: HTMLInputElement, signal: AbortSignal) => {
    set(fileInput$, element);
    signal.addEventListener(
      "abort",
      () => {
        set(fileInput$, null);
      },
      { once: true },
    );
  }),
);
export const openLandingFileInput$ = command(({ get }) => {
  get(fileInput$)?.click();
});
