import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, FileText } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  surfaceVariants,
  cn,
} from "@okouai/ui";
import {
  sourcesFirstUi$,
  updateSourcesFirstDraft$,
  updateSourcesFirstUi$,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import {
  OnboardingIllustration,
  ProductMark,
} from "./onboarding-step-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

const SKILL_FILE_ACCEPT = ".md,text/markdown";
const OKOU_APP_ICON_URL = "/icons/icon-192.png";
const SKILL_FILE_INPUT_ID = "onboarding-skill-file";

/** Confirms the chosen SKILL.md before it becomes a personal workflow. */
function SkillImportDialog() {
  const { t } = useTranslation();
  const ui = useGet(sourcesFirstUi$);
  const updateUi = useSet(updateSourcesFirstUi$);
  const updateDraft = useSet(updateSourcesFirstDraft$);

  return (
    <Dialog
      open={ui.pendingSkillName !== null}
      onOpenChange={(open) => {
        if (!open) {
          updateUi({ pendingSkillName: null });
        }
      }}
    >
      <DialogContent maxWidth="sm" contentClassName="p-6">
        <DialogTitle className="text-base font-semibold">
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.previewTitle;
          })}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.previewCopy;
          })}
        </DialogDescription>
        <p
          className={cn(
            surfaceVariants(),
            "mt-4 truncate p-3 text-sm text-foreground",
          )}
        >
          {ui.pendingSkillName}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              updateUi({ pendingSkillName: null });
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.common.cancel;
            })}
          </Button>
          <Button
            type="button"
            onClick={() => {
              // Frontend pass: the SKILL.md upload becomes a personal workflow
              // once the import endpoint is wired.
              updateDraft({ importedWorkflowName: ui.pendingSkillName });
              updateUi({ pendingSkillName: null });
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.confirm;
            })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The file the import produced, as the row a workflow list would show. */
function ImportedSkillRow({ name }: { readonly name: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-left">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground"
        aria-hidden="true"
      >
        <FileText size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {name}
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
 * The drop target and the imported workflow read as one column on the step's
 * own sheet, so importing a file only changes what the column says.
 */
function SkillDropCard({ imported }: { readonly imported: string | null }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center gap-4 text-center">
      {imported ? (
        <>
          <ImportedSkillRow name={imported} />
          {/* A label opens the file picker without reaching for the DOM. */}
          <Button
            variant="ghost"
            size="sm"
            render={<label htmlFor={SKILL_FILE_INPUT_ID} />}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.replace;
            })}
          </Button>
        </>
      ) : (
        <>
          <OnboardingIllustration name="skill-import" alt="" size="poster" />
          <span>
            <span className="block text-sm font-medium text-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.skills.panelTitle;
              })}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.skills.panelCopy;
              })}
            </span>
          </span>
          <Button render={<label htmlFor={SKILL_FILE_INPUT_ID} />}>
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.import;
            })}
          </Button>
        </>
      )}
    </div>
  );
}

export function OnboardingSkillsPage() {
  const { t } = useTranslation();
  const flow = useSourcesFirstFlow("skills");
  const updateUi = useSet(updateSourcesFirstUi$);
  const imported = flow.draft.importedWorkflowName;

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={
        imported
          ? t(($) => {
              return $.onboarding.sourcesFirst.skills.importedTitle;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.skills.title;
            })
      }
      description={t(($) => {
        return $.onboarding.sourcesFirst.skills.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={flow.goNext}
      primaryDisabled={imported === null}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.skip;
      })}
      onSecondary={flow.goNext}
      onBack={flow.goBack}
    >
      <SkillDropCard imported={imported} />
      <input
        id={SKILL_FILE_INPUT_ID}
        type="file"
        accept={SKILL_FILE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            updateUi({ pendingSkillName: file.name.replace(/\.md$/u, "") });
          }
        }}
      />
      <SkillImportDialog />
    </OnboardingStepLayout>
  );
}

/** One message in the mocked channel: the author's mark, then what they said. */
function SlackMessage({
  avatar,
  author,
  badge,
  time,
  body,
}: {
  readonly avatar: ReactNode;
  readonly author: string;
  readonly badge?: string;
  readonly time: string;
  readonly body: string;
}) {
  return (
    <div className="flex gap-2.5">
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-semibold text-foreground">
            {author}
          </span>
          {badge ? (
            <span className="rounded-sm bg-muted px-1 py-px text-[10px] font-semibold uppercase leading-4 text-muted-foreground">
              {badge}
            </span>
          ) : null}
          <span className="text-[11px] text-muted-foreground">{time}</span>
        </div>
        <p className="mt-0.5 text-sm leading-6 text-foreground">{body}</p>
      </div>
    </div>
  );
}

/**
 * What the step is actually offering, drawn as the channel it happens in: the
 * teammate's ask, then Okou answering as an app in the same thread.
 */
function SlackPreview() {
  const { t } = useTranslation();
  const askAuthor = t(($) => {
    return $.onboarding.sourcesFirst.slack.previewAskAuthor;
  });

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      {/* The window's own bar, so the mock reads as Slack rather than Okou. */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/15" />
        </span>
        <span className="ml-1 text-xs font-semibold text-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewChannel;
          })}
        </span>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        <SlackMessage
          avatar={
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--gray-200))] text-xs font-semibold text-foreground"
              aria-hidden="true"
            >
              {askAuthor.charAt(0)}
            </span>
          }
          author={askAuthor}
          time={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewTime;
          })}
          body={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewAsk;
          })}
        />
        <SlackMessage
          avatar={
            <img
              src={OKOU_APP_ICON_URL}
              alt=""
              className="size-8 shrink-0 rounded-md object-cover"
            />
          }
          author={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewReplyAuthor;
          })}
          badge={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewAppBadge;
          })}
          time={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewReplyTime;
          })}
          body={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewReply;
          })}
        />
      </div>
      {/* The composer: the line the next ask would be typed on. */}
      <div className="border-t border-border/60 px-4 py-3">
        <p className="rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewComposer;
          })}
        </p>
      </div>
    </div>
  );
}

export function OnboardingSlackPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const flow = useSourcesFirstFlow("slack");
  const connected = flow.draft.slackStatus === "connected";

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={
        connected
          ? t(($) => {
              return $.onboarding.sourcesFirst.slack.connectedTitle;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.slack.title;
            })
      }
      description={
        connected
          ? t(($) => {
              return $.onboarding.sourcesFirst.slack.connectedCopy;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.slack.copy;
            })
      }
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.finish;
      })}
      onPrimary={flow.goNext}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.skip;
      })}
      onSecondary={flow.goNext}
      onBack={flow.goBack}
    >
      {/* One column on the step's own sheet: what it looks like in a channel,
          then the one way to add it. */}
      <div className="mx-auto flex w-full max-w-[420px] flex-col gap-5">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.rowTitle;
            })}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.rowCopy;
            })}
          </p>
        </div>
        <SlackPreview />
        <Button
          type="button"
          variant={connected ? "outline" : "neutral"}
          disabled={connected}
          className="w-full gap-2"
          onClick={() => {
            // Frontend pass: the Slack install round trip replaces this once
            // the integration step is wired.
            updateDraft({ slackStatus: "connected" });
          }}
        >
          {connected ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <ProductMark name="slack" alt="" />
          )}
          {connected
            ? t(($) => {
                return $.onboarding.sourcesFirst.slack.connectedStatus;
              })
            : t(($) => {
                return $.onboarding.sourcesFirst.slack.add;
              })}
        </Button>
      </div>
    </OnboardingStepLayout>
  );
}
