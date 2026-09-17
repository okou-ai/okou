import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import {
  Button,
  Card,
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
  OnboardingPanel,
  ProductMark,
} from "./onboarding-step-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useWelcomeHandoff } from "./onboarding-welcome-dialog.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

const SKILL_FILE_ACCEPT = ".md,text/markdown";
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

/** The drop target, or the workflow the import already produced. */
function SkillDropCard({ imported }: { readonly imported: string | null }) {
  const { t } = useTranslation();

  return (
    <Card className="flex flex-col items-center px-6 pb-8 pt-8 text-center">
      <OnboardingIllustration name="workflow-default" alt="" size="header" />
      <p className="mt-4 text-sm font-medium text-foreground">
        {imported ??
          t(($) => {
            return $.onboarding.sourcesFirst.skills.panelTitle;
          })}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {imported
          ? t(($) => {
              return $.onboarding.sourcesFirst.skills.importedCopy;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.skills.panelCopy;
            })}
      </p>
      {imported ? null : (
        // A label opens the file picker without reaching for the DOM.
        <Button
          className="mt-4"
          render={<label htmlFor={SKILL_FILE_INPUT_ID} />}
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.import;
          })}
        </Button>
      )}
    </Card>
  );
}

export function OnboardingSkillsPage() {
  const { t } = useTranslation();
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("skills", openWelcome);
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
      contentWidth="single"
    >
      {welcomeDialog}
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

/** What the step is actually offering: Okou answering in a channel. */
function SlackPreview() {
  const { t } = useTranslation();

  return (
    <div className="px-5 py-4">
      <div className="rounded-xl bg-muted/40 p-4">
        <p className="text-xs font-medium text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewChannel;
          })}
        </p>
        <p className="mt-3 text-sm text-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewAsk;
          })}
        </p>
        <p className="mt-3 rounded-lg bg-card p-3 text-sm text-foreground shadow-surface">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewReply;
          })}
        </p>
      </div>
    </div>
  );
}

export function OnboardingSlackPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("slack", openWelcome);
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
      contentWidth="single"
    >
      {welcomeDialog}
      <OnboardingPanel
        mark={<ProductMark name="slack" alt="" size="header" />}
        title={t(($) => {
          return $.onboarding.sourcesFirst.slack.rowTitle;
        })}
        description={t(($) => {
          return $.onboarding.sourcesFirst.slack.rowCopy;
        })}
      >
        <SlackPreview />
        <div className="px-5 pb-5">
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
            {connected ? <Check size={16} aria-hidden="true" /> : null}
            {connected
              ? t(($) => {
                  return $.onboarding.sourcesFirst.slack.connectedStatus;
                })
              : t(($) => {
                  return $.onboarding.sourcesFirst.slack.add;
                })}
          </Button>
        </div>
      </OnboardingPanel>
    </OnboardingStepLayout>
  );
}
