// The skill import prompt and its imported list, shared by the onboarding
// skills step and the workflows page's import dialog.
import type { Command } from "ccstate";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, Copy, FileText, Loader2 } from "lucide-react";
import { Button } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { SkillImportSignals } from "../../signals/skill-import/skill-import.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingIllustration } from "../onboarding-sources-first/onboarding-step-parts.tsx";

/** The prompt itself: long, read in full, and selectable where it stands. */
function SkillImportPromptBody({ prompt }: { readonly prompt: string }) {
  const { t } = useTranslation();

  return (
    <pre
      // A named, focusable scroll container: the prompt is long, so it is
      // read and selected where it stands rather than in a dialog.
      role="region"
      tabIndex={0}
      aria-label={t(($) => {
        return $.onboarding.sourcesFirst.skills.promptLabel;
      })}
      className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/30 p-4 font-mono text-xs leading-5 text-muted-foreground"
    >
      {prompt}
    </pre>
  );
}

/** The session is still opening: the import says so where the prompt will be. */
function SkillImportPromptPending() {
  const { t } = useTranslation();

  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground"
    >
      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      {t(($) => {
        return $.onboarding.sourcesFirst.skills.preparing;
      })}
    </p>
  );
}

/**
 * The session could not be opened. The import offers it again and stays out
 * of the way otherwise: nothing around it waited on it.
 */
function SkillImportPromptFailed({
  retry$,
}: {
  readonly retry$: Command<Promise<void>, [AbortSignal]>;
}) {
  const { t } = useTranslation();
  const retry = useSet(retry$);
  const pageSignal = useGet(pageSignal$);

  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-border/60 bg-muted/30 p-4">
      <p role="alert" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.startError;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          detach(retry(pageSignal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.tryAgain;
        })}
      </Button>
    </div>
  );
}

/** Copies the prompt, and says whether the clipboard took it. */
function SkillImportCopyButton({
  copied,
  copyPrompt$,
}: {
  readonly copied: boolean;
  readonly copyPrompt$: Command<Promise<boolean>, [AbortSignal]>;
}) {
  const { t } = useTranslation();
  const copyPrompt = useSet(copyPrompt$);
  const pageSignal = useGet(pageSignal$);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 gap-1.5"
      onClick={() => {
        detach(
          (async () => {
            if (await copyPrompt(pageSignal)) {
              return;
            }
            toast.error(
              t(($) => {
                return $.onboarding.sourcesFirst.skills.copyError;
              }),
            );
          })(),
          Reason.DomCallback,
        );
      }}
    >
      {copied ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      {copied
        ? t(($) => {
            return $.onboarding.sourcesFirst.skills.copied;
          })
        : t(($) => {
            return $.onboarding.sourcesFirst.skills.copyPrompt;
          })}
    </Button>
  );
}

/** One skill the import wrote, as the row the workflow list would show. */
function ImportedSkillRow({ skill }: { readonly skill: WorkflowSummary }) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-left">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground"
        aria-hidden="true"
      >
        <FileText size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {skill.displayName ?? skill.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.importedCopy;
          })}
        </span>
      </span>
      <Check size={16} className="shrink-0 text-emerald-600" />
    </div>
  );
}

/**
 * What the import has produced so far. The list is polled, so a skill appears
 * here on its own; until one does, the import says what it is waiting for.
 */
export function ImportedSkillList({
  skills,
}: {
  readonly skills: readonly WorkflowSummary[];
}) {
  const { t } = useTranslation();

  return (
    <div>
      <p className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.importedLabel;
        })}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {skills.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/70 px-4 py-3">
            <OnboardingIllustration name="skill-import" alt="" />
            <span className="text-sm text-muted-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.skills.waiting;
              })}
            </span>
          </div>
        ) : (
          skills.map((skill) => {
            return <ImportedSkillRow key={skill.id} skill={skill} />;
          })
        )}
      </div>
    </div>
  );
}

/**
 * The prompt for one tool, with its copy button, or where it will be while the
 * session opens or after it could not.
 */
export function SkillImportPanel({
  signals,
  providerName,
  retry$,
}: {
  readonly signals: SkillImportSignals;
  readonly providerName: string;
  /** Opens the session again, under whatever owns this import's lifetime. */
  readonly retry$: Command<Promise<void>, [AbortSignal]>;
}) {
  const state = useGet(signals.state$);
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t(
              ($) => {
                return $.onboarding.sourcesFirst.skills.promptTitle;
              },
              { provider: providerName },
            )}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.promptCopy;
            })}
          </p>
        </div>
        {state.prompt === null ? null : (
          <SkillImportCopyButton
            copied={state.copied}
            copyPrompt$={signals.copyPrompt$}
          />
        )}
      </div>
      {state.prompt === null ? (
        state.status === "failed" ? (
          <SkillImportPromptFailed retry$={retry$} />
        ) : (
          <SkillImportPromptPending />
        )
      ) : (
        <SkillImportPromptBody prompt={state.prompt} />
      )}
    </div>
  );
}
