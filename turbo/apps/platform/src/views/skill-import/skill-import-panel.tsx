// The skill import prompt and its imported list, shared by the onboarding
// skills step and the workflows page's import dialog.
import type { Command } from "ccstate";
import type { ReactNode } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Copy, FileText, Loader2 } from "lucide-react";
import {
  Button,
  buttonVariants,
  cn,
  surfaceVariants,
  type ButtonProps,
} from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type {
  SkillImportProvider,
  SkillImportSignals,
} from "../../signals/skill-import/skill-import.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { SkillImportGuide } from "./skill-import-guide.tsx";

/** The prompt itself: long, read in full, and selectable where it stands. */
function SkillImportPromptBody({
  prompt,
  signals,
  embedded = false,
}: {
  readonly prompt: string;
  readonly signals: SkillImportSignals;
  readonly embedded?: boolean;
}) {
  const { t } = useTranslation();
  const displayed = useSet(signals.promptDisplayed$);

  return (
    <pre
      ref={displayed}
      // A named, focusable scroll container: the prompt is long, so it is
      // read and selected where it stands. The session token and URLs are
      // single unbroken tokens, so they may wrap anywhere rather than widen
      // whatever holds the prompt.
      role="region"
      tabIndex={0}
      aria-label={t(($) => {
        return $.onboarding.sourcesFirst.skills.promptLabel;
      })}
      className={cn(
        "max-h-[240px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] p-4 font-mono text-xs leading-5 text-muted-foreground",
        embedded
          ? "border-t border-divider bg-gray-50"
          : "rounded-xl border border-border/60 bg-muted/30",
      )}
    >
      {prompt}
    </pre>
  );
}

/** The session is still opening: the import says so where the prompt will be. */
function SkillImportPromptPending({
  embedded,
}: {
  readonly embedded: boolean;
}) {
  const { t } = useTranslation();

  return (
    <p
      role="status"
      className={cn(
        "flex items-center gap-2 p-4 text-sm text-muted-foreground",
        !embedded && "rounded-xl border border-border/60 bg-muted/30",
      )}
    >
      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      {t(($) => {
        return $.onboarding.sourcesFirst.skills.preparing;
      })}
    </p>
  );
}

function SkillImportPromptFailed({ embedded }: { readonly embedded: boolean }) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 p-4",
        !embedded && "rounded-xl border border-border/60 bg-muted/30",
      )}
    >
      <p role="alert" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.startError;
        })}
      </p>
    </div>
  );
}

/** Copies the prompt, and says whether the clipboard took it. */
export function SkillImportCopyButton({
  copyPrompt$,
  primary = false,
  size = "sm",
  className,
  label,
  disabled = false,
  showPending = false,
}: {
  readonly copyPrompt$: Command<Promise<boolean>, [AbortSignal]>;
  /** Where copying is the one thing to do, it is the primary action. */
  readonly primary?: boolean;
  readonly size?: ButtonProps["size"];
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly showPending?: boolean;
}) {
  const { t } = useTranslation();
  const [copyResult, copyPrompt] = useLoadableSet(copyPrompt$);
  const copied = copyResult.state === "hasData" && copyResult.data;
  const pageSignal = useGet(pageSignal$);

  return (
    <Button
      type="button"
      variant={primary ? "default" : "outline"}
      size={size}
      className={cn("shrink-0 gap-1.5", className)}
      disabled={disabled || copyResult.state === "loading"}
      pending={showPending && copyResult.state === "loading"}
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
        : (label ??
          t(($) => {
            return $.onboarding.sourcesFirst.skills.copyPrompt;
          }))}
    </Button>
  );
}

/** One skill the import wrote, as the row the workflow list would show. */
function ImportedSkillRow({ skill }: { readonly skill: WorkflowSummary }) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <FileText size={16} />
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
 * The authoritative results of this session, refreshed by server notifications.
 */
function ImportedSkillList({
  skills,
  scroll = false,
  compact = false,
}: {
  readonly skills: readonly WorkflowSummary[];
  /** Keeps a long import to a few rows, scrolling within the list. */
  readonly scroll?: boolean;
  readonly compact?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div>
      <p className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.importedLabel;
        })}
        {skills.length > 0 ? (
          <span className="ml-1.5 font-normal text-muted-foreground">
            {skills.length}
          </span>
        ) : null}
      </p>
      {skills.length === 0 ? (
        <p
          className={cn(
            "text-sm text-muted-foreground",
            compact
              ? "mt-1 leading-6"
              : "mt-2 rounded-xl border border-dashed border-border/70 px-4 py-3",
          )}
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.waiting;
          })}
        </p>
      ) : (
        <div
          className={cn(
            "mt-2 divide-y",
            compact
              ? "divide-divider"
              : "divide-border/60 rounded-xl border border-border/60",
            scroll && "max-h-[228px] overflow-y-auto",
          )}
        >
          {skills.map((skill) => {
            return <ImportedSkillRow key={skill.id} skill={skill} />;
          })}
        </div>
      )}
    </div>
  );
}

/** A failed result read must not look like an empty import. */
function SkillImportResultsContent({
  signals,
  scroll = false,
  compact = false,
}: {
  readonly signals: SkillImportSignals;
  readonly scroll?: boolean;
  readonly compact?: boolean;
}) {
  const result = useLoadable(signals.imported$);
  const { t } = useTranslation();
  if (result.state === "hasError") {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 text-sm text-muted-foreground"
      >
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.resultsError;
        })}
      </div>
    );
  }
  if (result.state === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.loadingResults;
        })}
      </p>
    );
  }
  return (
    <ImportedSkillList skills={result.data} scroll={scroll} compact={compact} />
  );
}

export function SkillImportResults({
  signals,
  scroll = false,
  compact = false,
}: {
  readonly signals: SkillImportSignals;
  readonly scroll?: boolean;
  readonly compact?: boolean;
}) {
  const content = (
    <SkillImportResultsContent
      signals={signals}
      scroll={scroll}
      compact={compact}
    />
  );
  return compact ? (
    <div className={surfaceVariants({ className: "p-5" })}>{content}</div>
  ) : (
    content
  );
}

/**
 * Where the import stands, in one line: waiting for the first skill, then how
 * many have arrived while it keeps listening for more.
 */
export function SkillImportStatus({ count }: { readonly count: number }) {
  const { t } = useTranslation();

  return (
    <p
      role="status"
      className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />
      <span className="truncate">
        {count === 0
          ? t(($) => {
              return $.onboarding.sourcesFirst.skills.waiting;
            })
          : t(
              ($) => {
                return $.onboarding.sourcesFirst.skills.importedCount;
              },
              { count },
            )}
      </span>
    </p>
  );
}

/** Whether the full prompt is shown under the copy step. */
export interface SkillImportPromptToggle {
  readonly shown: boolean;
  readonly setShown: (shown: boolean) => void;
}

/** Copying is all most people need; the full text stays one click away. */
function SkillImportFullPromptToggle({
  toggle,
  fullWidth = false,
}: {
  readonly toggle: SkillImportPromptToggle;
  readonly fullWidth?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Button
      type="button"
      variant="quiet"
      size={fullWidth ? "default" : "xs"}
      className={fullWidth ? "w-full justify-between" : "-ml-2.5 gap-1 text-xs"}
      aria-expanded={toggle.shown}
      onClick={() => {
        toggle.setShown(!toggle.shown);
      }}
    >
      <ChevronDown
        size={14}
        aria-hidden="true"
        className={cn(
          "transition-transform",
          toggle.shown && "rotate-180",
          fullWidth && "order-last",
        )}
      />
      {toggle.shown
        ? t(($) => {
            return $.onboarding.sourcesFirst.skills.hideFullPrompt;
          })
        : t(($) => {
            return $.onboarding.sourcesFirst.skills.showFullPrompt;
          })}
    </Button>
  );
}

function CompactSkillImportPanel({
  provider,
  providerName,
  prompt,
  pending,
  signals,
  promptToggle,
}: {
  readonly provider: SkillImportProvider;
  readonly providerName: string;
  readonly prompt: string | null;
  readonly pending: ReactNode;
  readonly signals: SkillImportSignals;
  readonly promptToggle: SkillImportPromptToggle;
}) {
  const { t } = useTranslation();

  return (
    <div className={surfaceVariants({ className: "overflow-hidden" })}>
      <ol className="list-inside list-decimal space-y-2 p-5 text-sm leading-6">
        <li>
          {t(($) => {
            return $.onboarding.sourcesFirst.mobile.copyImportPrompt;
          })}
        </li>
        <li>
          {t(
            ($) => {
              return $.onboarding.sourcesFirst.mobile.pasteIntoProvider;
            },
            {
              provider: providerName,
            },
          )}
        </li>
      </ol>
      <div className="border-t border-divider p-1">
        <details className="group">
          <summary
            className={cn(
              buttonVariants({ variant: "quiet", size: "default" }),
              "flex w-full list-none justify-between [&::-webkit-details-marker]:hidden",
            )}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.mobile.instructions;
            })}
            <ChevronDown
              aria-hidden="true"
              className="transition-transform group-open:rotate-180"
            />
          </summary>
          <SkillImportGuide provider={provider} className="px-4 pb-4 pt-2" />
        </details>
        {prompt === null ? null : (
          <SkillImportFullPromptToggle toggle={promptToggle} fullWidth />
        )}
      </div>
      {prompt === null ? (
        pending
      ) : promptToggle.shown ? (
        <SkillImportPromptBody prompt={prompt} signals={signals} embedded />
      ) : null}
    </div>
  );
}

/**
 * The prompt for one tool, with its copy button and where in the tool to run
 * it, or where it will be while the session opens or after it could not.
 * Given a prompt toggle, the panel is compact: the tool's window leads, and
 * the steps start with copying, the full prompt folded beneath that step.
 */
export function SkillImportPanel({
  signals,
  provider,
  providerName,
  promptToggle,
  compact = false,
}: {
  readonly signals: SkillImportSignals;
  readonly provider: SkillImportProvider;
  readonly providerName: string;
  readonly promptToggle?: SkillImportPromptToggle;
  readonly compact?: boolean;
}) {
  const preparation = useLoadable(signals.session$);
  const results = useLoadable(signals.imported$);
  const session = preparation.state === "hasData" ? preparation.data : null;
  const prompt = session?.prompt ?? null;
  const { t } = useTranslation();
  const pending =
    preparation.state === "hasError" ? (
      <SkillImportPromptFailed embedded={compact} />
    ) : (
      <SkillImportPromptPending embedded={compact} />
    );

  if (compact && promptToggle) {
    return (
      <CompactSkillImportPanel
        provider={provider}
        providerName={providerName}
        prompt={prompt}
        pending={pending}
        signals={signals}
        promptToggle={promptToggle}
      />
    );
  }

  if (promptToggle) {
    // Until a skill arrives, copying is the one thing to do; after that,
    // viewing the workflows takes over as the primary action.
    return (
      <SkillImportGuide
        provider={provider}
        stacked
        copyStep={{
          action:
            session === null ? null : (
              <SkillImportCopyButton
                key={session.id}
                copyPrompt$={signals.copyPrompt$}
                primary={
                  results.state !== "hasData" || results.data.length === 0
                }
              />
            ),
          detail:
            prompt === null ? (
              <div className="mt-2">{pending}</div>
            ) : (
              <>
                <SkillImportFullPromptToggle toggle={promptToggle} />
                {promptToggle.shown ? (
                  <div className="mt-2">
                    <SkillImportPromptBody prompt={prompt} signals={signals} />
                  </div>
                ) : null}
              </>
            ),
        }}
      />
    );
  }

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
        {session === null ? null : (
          <SkillImportCopyButton
            key={session.id}
            copyPrompt$={signals.copyPrompt$}
          />
        )}
      </div>
      <SkillImportGuide
        provider={provider}
        className="rounded-xl border border-border/60 bg-muted/30 p-4"
      />
      {prompt === null ? (
        pending
      ) : (
        <SkillImportPromptBody prompt={prompt} signals={signals} />
      )}
    </div>
  );
}
