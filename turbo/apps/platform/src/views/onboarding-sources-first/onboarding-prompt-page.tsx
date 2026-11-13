import { LoadingSkeleton } from "../components/loading-skeleton.tsx";
import type { ClipboardEvent } from "react";
import type { Computed } from "ccstate";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button, IconButton, Textarea, cn } from "@okouai/ui";
import { X } from "lucide-react";
import {
  MARKETING_HANDOFF_MAX_FILES,
  MARKETING_HANDOFF_PROMPT_MAX_CHARS,
} from "@okouai/api-contracts/validators/marketing-handoffs";
import { useTranslation } from "react-i18next";
import { runPromptOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import { onboardingMakeConnectorSlugs$ } from "../../signals/onboarding/onboarding-connector-items.ts";
import {
  editOnboardingPrompt$,
  hasUnresolvedOnboardingPastedFiles$,
  onboardingDraft$,
  onboardingPasteRejection$,
  onboardingPastedFileUploads$,
  onboardingPromptCharacterCount$,
  onboardingPromptTooLong$,
  pasteOnboardingText$,
  removeOnboardingFile$,
  removeOnboardingPastedFile$,
  retryOnboardingPastedFile$,
  selectOnboardingPromptOutput$,
} from "../../signals/onboarding/onboarding-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { OnboardingConnectorSetup } from "../onboarding/onboarding-connectors.tsx";
import { ONBOARDING_TEXTAREA_CLASS } from "../onboarding/onboarding-shell.tsx";
import {
  OnboardingCompliance,
  OnboardingSecurityLink,
} from "./onboarding-industry-parts.tsx";
import { useMobileOnboarding } from "../onboarding/use-mobile-onboarding.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { OnboardingOutputFormats } from "./onboarding-output-formats.tsx";

/**
 * What the prompt handoff does: the prompt the visitor brought stays editable,
 * recommended tools and those its link names can be connected, and running it
 * completes onboarding before the first request.
 */
function usePromptOnboarding() {
  const draft = useGet(onboardingDraft$);
  const setPrompt = useSet(editOnboardingPrompt$);
  const selectOutput = useSet(selectOnboardingPromptOutput$);
  const [runLoadable, runPrompt] = useLoadableSet(runPromptOnboarding$);
  const pageSignal = useGet(pageSignal$);
  const connectorSlugs = useGet(onboardingMakeConnectorSlugs$);
  const unresolvedFiles = useGet(hasUnresolvedOnboardingPastedFiles$);
  const tooLong = useGet(onboardingPromptTooLong$);
  const pasteText = useSet(pasteOnboardingText$);

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const clipboard = event.clipboardData;
    const hasFileItems =
      clipboard.files.length > 0 ||
      Array.from(clipboard.items).some((item) => {
        return item.kind === "file";
      });
    const operation = pasteText(
      clipboard.getData("text/plain"),
      hasFileItems,
      pageSignal,
    );
    if (operation) {
      // Native paste is replaced only after the complete text has been retained
      // as an uploadable File. Size/count rejections keep the native paste.
      event.preventDefault();
      detach(operation, Reason.DomCallback);
    }
  };

  const run = (): void => {
    detach(runPrompt(pageSignal), Reason.DomCallback);
  };

  return {
    prompt: draft.prompt,
    output: draft.output,
    files: draft.files,
    setPrompt,
    selectOutput,
    connectorSlugs,
    unresolvedFiles,
    tooLong,
    paste,
    run,
    runError:
      runLoadable.state === "hasError" && runLoadable.error instanceof Error
        ? runLoadable.error.message
        : null,
    busy: runLoadable.state === "loading",
  };
}

function OnboardingPastedFile({
  file,
  result$,
}: {
  readonly file: File;
  readonly result$: Computed<Promise<void>>;
}) {
  const { t } = useTranslation();
  const result = useLoadable(result$);
  const pageSignal = useGet(pageSignal$);
  const retry = useSet(retryOnboardingPastedFile$);
  const remove = useSet(removeOnboardingPastedFile$);
  return (
    <li className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="break-words">{file.name}</p>
        {result.state === "loading" && (
          <LoadingSkeleton
            variant="text"
            label={t(
              ($) => {
                return $.chat.attachments.loadingFile;
              },
              { filename: file.name },
            )}
          />
        )}
        {result.state === "hasError" && (
          <p role="alert" className="text-xs text-destructive">
            {t(
              ($) => {
                return $.onboarding.sourcesFirst.prompt.uploadFailed;
              },
              { filename: file.name },
            )}
          </p>
        )}
      </div>
      {result.state === "hasError" && (
        <Button
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => {
            detach(retry(file, pageSignal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.artifacts.actions.retry;
          })}
        </Button>
      )}
      <IconButton
        type="button"
        aria-label={t(
          ($) => {
            return $.chat.attachments.remove;
          },
          { filename: file.name },
        )}
        onClick={() => {
          remove(file);
        }}
      >
        <X className="size-4" aria-hidden="true" />
      </IconButton>
    </li>
  );
}

function OnboardingPromptFeedback({
  runError,
}: {
  readonly runError: string | null;
}) {
  const { t } = useTranslation();
  const characterCount = useGet(onboardingPromptCharacterCount$);
  const tooLong = useGet(onboardingPromptTooLong$);
  const pasteRejection = useGet(onboardingPasteRejection$);
  return (
    <>
      <p
        id="onboarding-prompt-count"
        role="status"
        className={cn(
          "text-xs text-muted-foreground",
          tooLong && "text-destructive",
        )}
      >
        {t(
          ($) => {
            return $.onboarding.sourcesFirst.prompt.characterCount;
          },
          { current: characterCount, max: MARKETING_HANDOFF_PROMPT_MAX_CHARS },
        )}
      </p>
      {tooLong && (
        <p
          id="onboarding-prompt-error"
          role="alert"
          className="text-sm text-destructive"
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.prompt.tooLong;
          })}
        </p>
      )}
      {pasteRejection && (
        <p role="alert" className="text-sm text-destructive">
          {t(
            ($) => {
              return pasteRejection.reason === "size"
                ? $.onboarding.sourcesFirst.prompt.fileTooLarge
                : $.onboarding.sourcesFirst.prompt.tooManyFiles;
            },
            {
              filename: pasteRejection.filename,
              max: MARKETING_HANDOFF_MAX_FILES,
            },
          )}
        </p>
      )}
      {runError && (
        <p role="alert" className="text-sm text-destructive">
          {runError}
        </p>
      )}
    </>
  );
}

function OnboardingPromptAttachments({ busy }: { readonly busy: boolean }) {
  const { t } = useTranslation();
  const { files } = useGet(onboardingDraft$);
  const pastedFiles = useGet(onboardingPastedFileUploads$);
  const removeFile = useSet(removeOnboardingFile$);
  const fileLabels = [
    ...new Map(
      files.map((file) => {
        return [`${file.hash}:${file.filename}`, file] as const;
      }),
    ).values(),
  ];
  if (files.length === 0 && pastedFiles.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label={t(($) => {
        return $.chat.attachments.title;
      })}
      className="space-y-1 text-sm text-muted-foreground"
    >
      {fileLabels.map((file) => {
        return (
          <li
            key={`${file.hash}:${file.filename}`}
            className="flex items-center gap-2"
          >
            <span className="min-w-0 flex-1 break-words">{file.filename}</span>
            <IconButton
              type="button"
              disabled={busy}
              aria-label={t(
                ($) => {
                  return $.chat.attachments.remove;
                },
                { filename: file.filename },
              )}
              onClick={() => {
                removeFile(file);
              }}
            >
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          </li>
        );
      })}
      {pastedFiles.map((upload) => {
        return <OnboardingPastedFile key={upload.file.name} {...upload} />;
      })}
    </ul>
  );
}

/**
 * The prompt handoff in the source-first flow's look. A visitor who brings a
 * prompt skips that flow's questions, so this is their whole onboarding: one
 * step that explains how to tailor the task, connect relevant tools, and
 * choose an output format beside the editable prompt and its controls.
 */
export function OnboardingSourcesFirstPromptPage() {
  const { t } = useTranslation();
  const mobile = useMobileOnboarding();
  const {
    prompt,
    output,
    files,
    setPrompt,
    selectOutput,
    connectorSlugs,
    unresolvedFiles,
    tooLong,
    paste,
    run,
    runError,
    busy,
  } = usePromptOnboarding();
  const promptInput = (
    <Textarea
      id="onboarding-prompt"
      aria-label={t(($) => {
        return $.onboarding.make.promptLabel;
      })}
      value={prompt}
      disabled={busy}
      aria-invalid={tooLong || undefined}
      aria-describedby={
        tooLong
          ? "onboarding-prompt-count onboarding-prompt-error"
          : "onboarding-prompt-count"
      }
      onPaste={paste}
      onChange={(event) => {
        setPrompt(event.target.value);
      }}
      className={cn(
        ONBOARDING_TEXTAREA_CLASS,
        "min-h-40 resize-none px-4 py-3 leading-[1.625] max-sm:min-h-48 max-sm:text-base",
      )}
    />
  );

  return (
    <OnboardingStepLayout
      currentStep={1}
      totalSteps={1}
      title={t(($) => {
        return $.onboarding.make.promptTitle;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.prompt.intro;
      })}
      mobileTitle={t(($) => {
        return $.onboarding.sourcesFirst.mobile.promptTitle;
      })}
      mobileDescription=""
      mobileFooter={<OnboardingSecurityLink />}
      supplement={<OnboardingCompliance />}
      primaryLabel={t(($) => {
        return mobile
          ? $.onboarding.sourcesFirst.mobile.startTask
          : $.onboarding.common.next;
      })}
      onPrimary={run}
      primaryDisabled={
        tooLong || unresolvedFiles || (!prompt.trim() && files.length === 0)
      }
      primaryBusy={busy}
    >
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-3">
        {/* A phone stacks the introduction above the sheet already, so the
            mark would push the prompt further down the first screen. */}
        <div className="flex justify-center pb-6 max-sm:hidden">
          <ProductBrandMark decorative size="hero" />
        </div>
        {promptInput}
        <OnboardingPromptFeedback runError={runError} />
        <OnboardingPromptAttachments busy={busy} />
        <section
          aria-labelledby="onboarding-prompt-connectors-title"
          className="mt-3 space-y-3"
        >
          <div className="space-y-1">
            <h2
              id="onboarding-prompt-connectors-title"
              className="text-sm font-medium"
            >
              {t(($) => {
                return $.onboarding.sourcesFirst.prompt.connectorsTitle;
              })}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.prompt.connectorsDescription;
              })}
            </p>
          </div>
          <OnboardingConnectorSetup
            connectorSlugs={connectorSlugs}
            variant="sheet"
          />
        </section>
        <OnboardingOutputFormats
          output={output}
          onSelect={selectOutput}
          disabled={busy}
        />
      </div>
    </OnboardingStepLayout>
  );
}
