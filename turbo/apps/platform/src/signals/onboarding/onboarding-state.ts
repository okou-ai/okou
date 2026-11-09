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
  readonly output: OnboardingOutputFormat | null;
}

function emptyOnboardingDraft(): OnboardingDraft {
  return { prompt: "", output: null, files: [] };
}

const internalOnboardingDraft$ = state<OnboardingDraft>(emptyOnboardingDraft());

export const onboardingDraft$ = computed((get) => {
  return get(internalOnboardingDraft$);
});

export const onboardingPromptOutput$ = computed(
  (get): StartingPromptOutput | null => {
    get(locale$);
    const { output } = get(onboardingDraft$);
    if (!output) {
      return null;
    }
    const instruction = i18n.t(($) => {
      return $.onboarding.sourcesFirst.outputFormats.options[output]
        .instruction;
    });
    return { format: output, suffix: `\n\n${instruction}` };
  },
);

export const onboardingPromptCharacterCount$ = computed((get) => {
  return (
    get(onboardingDraft$).prompt.length +
    onboardingOutputSuffix(get(onboardingPromptOutput$)).length
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
  ({ set }, output: OnboardingOutputFormat | null): void => {
    set(internalOnboardingDraft$, (current) => {
      return { ...current, output };
    });
  },
);

export const resetOnboardingDraft$ = command(({ set }) => {
  set(internalOnboardingDraft$, emptyOnboardingDraft());
  set(pastedFileUploads$, []);
  set(pasteRejection$, null);
});

/** Select a task-shaped default once, independently of the editable task. */
export const hydrateOnboardingRoute$ = command(
  (
    { set },
    searchParams: URLSearchParams,
    handoff?: { prompt: string; files: MarketingHandoffFile[] },
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
    // Shared prompts can already include one of our output instructions.
    // Keep it in the format selection so submission includes it only once.
    const existingFormat = ONBOARDING_OUTPUT_FORMATS.find((format) => {
      return prompt.endsWith(`\n\n${copy.options[format].instruction}`);
    });
    if (existingFormat) {
      set(internalOnboardingDraft$, {
        prompt: prompt.slice(
          0,
          -copy.options[existingFormat].instruction.length - 2,
        ),
        output: existingFormat,
        files: handoff?.files ?? [],
      });
      return;
    }
    set(internalOnboardingDraft$, {
      prompt,
      output: prompt.trim() ? defaultOnboardingOutputFormat(prompt) : null,
      files: handoff?.files ?? [],
    });
  },
);
