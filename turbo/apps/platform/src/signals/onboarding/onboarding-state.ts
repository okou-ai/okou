import type { MarketingHandoffFile } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { marketingHandoffsContract } from "@okouai/api-contracts/client/marketing-handoffs";
import {
  MARKETING_HANDOFF_MAX_FILE_BYTES,
  MARKETING_HANDOFF_MAX_FILES,
  MARKETING_HANDOFF_PROMPT_MAX_CHARS,
} from "@okouai/api-contracts/validators/marketing-handoffs";
import { command, computed, state } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { locale$ } from "../locale.ts";
import { pastedTextFile$ } from "../pasted-text.ts";
import { defaultOnboardingOutputFormat } from "./onboarding-default-output-format.ts";
import {
  ONBOARDING_OUTPUT_FORMATS,
  onboardingOutputSuffix,
  type StartingPromptOutput,
  type OnboardingOutputFormat,
} from "./onboarding-output-format.ts";

export interface OnboardingDraft {
  readonly prompt: string;
  readonly files: MarketingHandoffFile[];
  readonly outputs: readonly OnboardingOutputFormat[];
  readonly multipleOutputs: boolean;
}

function emptyOnboardingDraft(): OnboardingDraft {
  return { prompt: "", outputs: [], multipleOutputs: false, files: [] };
}

const internalOnboardingDraft$ = state<OnboardingDraft>(emptyOnboardingDraft());

export const onboardingDraft$ = computed((get) => {
  return get(internalOnboardingDraft$);
});

export const onboardingPromptOutputs$ = computed(
  (get): readonly StartingPromptOutput[] => {
    get(locale$);
    return get(onboardingDraft$).outputs.map((format) => {
      const instruction = i18n.t(($) => {
        return $.onboarding.sourcesFirst.outputFormats.options[format]
          .instruction;
      });
      return { format, suffix: `\n\n${instruction}` };
    });
  },
);

export const onboardingPromptCharacterCount$ = computed((get) => {
  return (
    get(onboardingDraft$).prompt.length +
    get(onboardingPromptOutputs$).reduce((total, output) => {
      return total + onboardingOutputSuffix(output).length;
    }, 0)
  );
});

export const onboardingPromptTooLong$ = computed((get) => {
  return (
    get(onboardingPromptCharacterCount$) > MARKETING_HANDOFF_PROMPT_MAX_CHARS
  );
});

interface PastedFileUpload {
  readonly file: File;
  readonly attempt: string;
  readonly result: Promise<void>;
}

// Keep the source File until upload succeeds or the user explicitly removes it.
// A rejected operation must not silently discard text whose native paste we own.
const pastedFileUploads$ = state<PastedFileUpload[]>([]);
const pasteRejection$ = state<{
  readonly filename: string;
  readonly reason: "size" | "count";
} | null>(null);
export const onboardingPasteRejection$ = computed((get) => {
  return get(pasteRejection$);
});
export const hasUnresolvedOnboardingPastedFiles$ = computed((get) => {
  return get(pastedFileUploads$).length > 0;
});
export const onboardingPastedFileUploads$ = computed((get) => {
  return get(pastedFileUploads$).map((upload) => {
    return {
      file: upload.file,
      result$: computed(() => {
        return upload.result;
      }),
    };
  });
});

const uploadOnboardingPastedFile$ = command(
  async (
    { get, set },
    file: File,
    attempt: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    const parts: string[] = [];
    for (let index = 0; index < bytes.length; index += 0x80_00) {
      parts.push(
        String.fromCharCode(...bytes.subarray(index, index + 0x80_00)),
      );
    }
    const result = await accept(
      get(apiClient$)(marketingHandoffsContract).upload({
        body: {
          filename: file.name,
          contentType: file.type,
          data: btoa(parts.join("")),
        },
        fetchOptions: { signal, credentials: "include" },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (
      !get(pastedFileUploads$).some((upload) => {
        return upload.file === file && upload.attempt === attempt;
      })
    ) {
      return;
    }
    set(internalOnboardingDraft$, (current) => {
      return { ...current, files: [...current.files, result.body] };
    });
    set(pastedFileUploads$, (uploads) => {
      return uploads.filter((upload) => {
        return upload.file !== file;
      });
    });
  },
);

export const retryOnboardingPastedFile$ = command(
  ({ get, set }, file: File, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    if (
      !get(pastedFileUploads$).some((upload) => {
        return upload.file === file;
      })
    ) {
      return Promise.resolve();
    }
    const attempt = crypto.randomUUID();
    const result = set(uploadOnboardingPastedFile$, file, attempt, signal);
    set(pastedFileUploads$, (uploads) => {
      return uploads.map((upload) => {
        return upload.file === file ? { file, attempt, result } : upload;
      });
    });
    return result;
  },
);

/** A non-null operation means the textarea must prevent the native paste. */
export const pasteOnboardingText$ = command(
  (
    { get, set },
    text: string,
    hasFileItems: boolean,
    signal: AbortSignal,
  ): Promise<void> | null => {
    signal.throwIfAborted();
    set(pasteRejection$, null);
    const file = set(pastedTextFile$, text, hasFileItems);
    if (!file) {
      return null;
    }
    if (file.size > MARKETING_HANDOFF_MAX_FILE_BYTES) {
      set(pasteRejection$, { filename: file.name, reason: "size" });
      return null;
    }
    if (
      get(onboardingDraft$).files.length + get(pastedFileUploads$).length >=
      MARKETING_HANDOFF_MAX_FILES
    ) {
      set(pasteRejection$, { filename: file.name, reason: "count" });
      return null;
    }
    const attempt = crypto.randomUUID();
    const result = set(uploadOnboardingPastedFile$, file, attempt, signal);
    set(pastedFileUploads$, (uploads) => {
      return [...uploads, { file, attempt, result }];
    });
    return result;
  },
);

export const removeOnboardingPastedFile$ = command(({ set }, file: File) => {
  set(pastedFileUploads$, (uploads) => {
    return uploads.filter((upload) => {
      return upload.file !== file;
    });
  });
});

export const removeOnboardingFile$ = command(
  ({ set }, file: MarketingHandoffFile) => {
    set(internalOnboardingDraft$, (current) => {
      return {
        ...current,
        files: current.files.filter((candidate) => {
          return (
            candidate.hash !== file.hash || candidate.filename !== file.filename
          );
        }),
      };
    });
  },
);

export const editOnboardingPrompt$ = command(({ set }, prompt: string) => {
  set(internalOnboardingDraft$, (current) => {
    return { ...current, prompt };
  });
});

export const selectOnboardingPromptOutput$ = command(
  ({ set }, outputs: readonly OnboardingOutputFormat[]): void => {
    set(internalOnboardingDraft$, (current) => {
      return { ...current, outputs };
    });
  },
);

export const clearOnboardingPasteState$ = command(({ set }) => {
  set(pastedFileUploads$, []);
  set(pasteRejection$, null);
});

export const resetOnboardingDraft$ = command(({ set }) => {
  set(internalOnboardingDraft$, emptyOnboardingDraft());
  set(clearOnboardingPasteState$);
});

/** Select a task-shaped default once, independently of the editable task. */
export const hydrateOnboardingRoute$ = command(
  (
    { set },
    searchParams: URLSearchParams,
    handoff: { prompt: string; files: MarketingHandoffFile[] } | undefined,
    allowMultipleOutputs: boolean,
  ) => {
    set(resetOnboardingDraft$);
    const prompt = handoff?.prompt ?? searchParams.get("prompt");
    if (prompt === null) {
      return;
    }
    const copy = i18n.t(
      ($) => {
        return $.onboarding.sourcesFirst.outputFormats;
      },
      { returnObjects: true },
    );
    // Strip known trailing instructions so a shared request submits each once.
    let task = prompt;
    const embedded: OnboardingOutputFormat[] = [];
    for (;;) {
      const format = ONBOARDING_OUTPUT_FORMATS.find((candidate) => {
        return task.endsWith(`\n\n${copy.options[candidate].instruction}`);
      });
      if (!format) {
        break;
      }
      task = task.slice(0, -copy.options[format].instruction.length - 2);
      if (!embedded.includes(format)) {
        embedded.unshift(format);
      }
      if (!allowMultipleOutputs) {
        break;
      }
    }
    const requested = (searchParams.get("outputFormats") ?? "").split(",");
    const explicit = ONBOARDING_OUTPUT_FORMATS.filter((format) => {
      return requested.includes(format);
    });
    const preferred =
      allowMultipleOutputs && explicit.length ? explicit : embedded;
    const defaultFormat = task.trim()
      ? defaultOnboardingOutputFormat(task)
      : null;
    const outputs = preferred.length
      ? preferred
      : defaultFormat
        ? [defaultFormat]
        : [];
    set(internalOnboardingDraft$, {
      prompt: task,
      outputs: allowMultipleOutputs ? outputs : outputs.slice(0, 1),
      multipleOutputs: allowMultipleOutputs && preferred.length > 1,
      files: handoff?.files ?? [],
    });
  },
);
