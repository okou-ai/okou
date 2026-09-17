import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronRight,
  Lock,
  Sparkles,
  Upload,
  Users,
} from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Radio,
  RadioGroup,
  cn,
} from "@okouai/ui";
import {
  sourcesFirstUi$,
  updateSourcesFirstDraft$,
  updateSourcesFirstUi$,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import {
  OnboardingFooter,
  OnboardingShell,
} from "../onboarding/onboarding-shell.tsx";
import {
  INDUSTRY_IDS,
  type IndustryId,
} from "./onboarding-sources-first-data.ts";
import { useWelcomeHandoff } from "./onboarding-welcome-dialog.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

const SKILL_FILE_ACCEPT = ".md,text/markdown";
const SKILL_FILE_INPUT_ID = "onboarding-skill-file";

export function OnboardingIndustryPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("industry", openWelcome);

  return (
    <OnboardingShell
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.industry.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.industry.copy;
      })}
      footer={
        <OnboardingFooter
          onBack={flow.goBack}
          onPrimary={flow.goNext}
          primaryLabel={t(($) => {
            return $.onboarding.sourcesFirst.common.continue;
          })}
          primaryDisabled={flow.draft.industry === null}
        />
      }
    >
      {welcomeDialog}
      <RadioGroup
        value={flow.draft.industry ?? ""}
        onValueChange={(value) => {
          updateDraft({ industry: value as IndustryId });
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        {INDUSTRY_IDS.map((id) => {
          const selected = flow.draft.industry === id;
          return (
            <label
              key={id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-state-hover",
              )}
            >
              <Radio value={id} className="mt-1" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {t(($) => {
                    return $.onboarding.sourcesFirst.industries[id].name;
                  })}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t(($) => {
                    return $.onboarding.sourcesFirst.industries[id].summary;
                  })}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </OnboardingShell>
  );
}

export function OnboardingTeamPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("team", openWelcome);
  const ui = useGet(sourcesFirstUi$);
  const updateUi = useSet(updateSourcesFirstUi$);

  const invite = (): void => {
    const value = ui.inviteEmail.trim();
    if (!value || flow.draft.invites.includes(value)) {
      return;
    }
    updateDraft({ invites: [...flow.draft.invites, value] });
    updateUi({ inviteEmail: "" });
  };

  return (
    <OnboardingShell
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.team.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.team.copy;
      })}
      footer={
        <OnboardingFooter
          onBack={flow.goBack}
          onPrimary={flow.goNext}
          primaryLabel={t(($) => {
            return $.onboarding.sourcesFirst.common.continue;
          })}
        />
      }
    >
      {welcomeDialog}
      <label className="text-sm font-medium" htmlFor="onboarding-invite-email">
        {t(($) => {
          return $.onboarding.sourcesFirst.team.label;
        })}
      </label>
      <div className="mt-2 flex gap-2">
        <Input
          id="onboarding-invite-email"
          type="email"
          autoComplete="off"
          value={ui.inviteEmail}
          placeholder={t(($) => {
            return $.onboarding.sourcesFirst.team.placeholder;
          })}
          onChange={(event) => {
            updateUi({ inviteEmail: event.target.value });
          }}
        />
        <Button type="button" variant="secondary" onClick={invite}>
          {t(($) => {
            return $.onboarding.sourcesFirst.team.invite;
          })}
        </Button>
      </div>
      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Lock size={14} aria-hidden="true" />
        {t(($) => {
          return $.onboarding.sourcesFirst.team.note;
        })}
      </p>
      {flow.draft.invites.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {flow.draft.invites.map((invitee) => {
            return (
              <Badge key={invitee} className="gap-1 text-xs">
                <Check size={12} aria-hidden="true" />
                {invitee}
              </Badge>
            );
          })}
        </div>
      ) : null}
    </OnboardingShell>
  );
}

export function OnboardingExperiencePage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("experience", openWelcome);

  // The answer decides the branch, so it is recorded before moving on.
  const choose = (experienced: boolean): void => {
    updateDraft({ experienced });
    flow.goNext();
  };

  return (
    <OnboardingShell
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.experience.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.experience.copy;
      })}
      footer={
        <OnboardingFooter
          onBack={flow.goBack}
          onPrimary={() => {
            choose(false);
          }}
          primaryLabel={t(($) => {
            return $.onboarding.sourcesFirst.common.skip;
          })}
        />
      }
    >
      {welcomeDialog}
      <div className="flex flex-col gap-3">
        {[true, false].map((experienced) => {
          return (
            <button
              key={String(experienced)}
              type="button"
              className="flex items-center gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-state-hover"
              onClick={() => {
                choose(experienced);
              }}
            >
              {experienced ? (
                <Sparkles size={20} aria-hidden="true" />
              ) : (
                <Users size={20} aria-hidden="true" />
              )}
              <span className="flex-1 text-sm font-medium">
                {experienced
                  ? t(($) => {
                      return $.onboarding.sourcesFirst.experience.yes;
                    })
                  : t(($) => {
                      return $.onboarding.sourcesFirst.experience.no;
                    })}
              </span>
              <ChevronRight
                size={18}
                aria-hidden="true"
                className="text-muted-foreground"
              />
            </button>
          );
        })}
      </div>
    </OnboardingShell>
  );
}

export function OnboardingSubscriptionPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("subscription", openWelcome);
  const connected = flow.draft.providerConnected;

  return (
    <OnboardingShell
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.subscription.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.subscription.copy;
      })}
      footer={
        <OnboardingFooter
          onBack={flow.goBack}
          onPrimary={
            connected
              ? flow.goNext
              : () => {
                  // Frontend pass: the personal model-provider connect flow is
                  // wired in the follow-up that adds the onboarding endpoints.
                  updateDraft({ providerConnected: true });
                }
          }
          primaryLabel={
            connected
              ? t(($) => {
                  return $.onboarding.sourcesFirst.common.continue;
                })
              : t(($) => {
                  return $.onboarding.sourcesFirst.subscription.connect;
                })
          }
        />
      }
    >
      {welcomeDialog}
      <RadioGroup
        value={flow.draft.provider}
        onValueChange={(value) => {
          updateDraft({
            provider: value === "claudeCode" ? "claudeCode" : "codex",
            providerConnected: false,
          });
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        {(["codex", "claudeCode"] as const).map((provider) => {
          const selected = flow.draft.provider === provider;
          return (
            <label
              key={provider}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-state-hover",
              )}
            >
              <Radio value={provider} />
              <span className="text-sm font-medium">
                {provider === "codex"
                  ? t(($) => {
                      return $.onboarding.sourcesFirst.subscription.codex;
                    })
                  : t(($) => {
                      return $.onboarding.sourcesFirst.subscription.claudeCode;
                    })}
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <p className="mt-4 text-xs text-muted-foreground">
        {connected
          ? t(($) => {
              return $.onboarding.sourcesFirst.subscription.connected;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.subscription.note;
            })}
      </p>
    </OnboardingShell>
  );
}

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
        <p className="mt-4 truncate rounded-lg border border-border p-3 text-sm">
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
              // Frontend pass: the SKILL.md upload becomes a personal
              // workflow once the import endpoint is wired.
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

export function OnboardingSkillsPage() {
  const { t } = useTranslation();
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("skills", openWelcome);
  const updateUi = useSet(updateSourcesFirstUi$);
  const imported = flow.draft.importedWorkflowName;

  return (
    <OnboardingShell
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
      footer={
        imported ? (
          <OnboardingFooter
            onBack={flow.goBack}
            onPrimary={flow.goNext}
            primaryLabel={t(($) => {
              return $.onboarding.sourcesFirst.common.continue;
            })}
          />
        ) : (
          <div className="flex w-full items-center justify-between gap-3">
            <Button type="button" variant="ghost" onClick={flow.goBack}>
              {t(($) => {
                return $.onboarding.sourcesFirst.common.back;
              })}
            </Button>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={flow.goNext}>
                {t(($) => {
                  return $.onboarding.sourcesFirst.common.skip;
                })}
              </Button>
              {/* A label opens the file picker without reaching for the DOM. */}
              <Button
                size="lg"
                render={<label htmlFor={SKILL_FILE_INPUT_ID} />}
              >
                {t(($) => {
                  return $.onboarding.sourcesFirst.skills.import;
                })}
              </Button>
            </div>
          </div>
        )
      }
    >
      {welcomeDialog}
      <div className="flex items-center gap-3 rounded-xl border border-border p-4">
        {imported ? (
          <Check size={20} aria-hidden="true" />
        ) : (
          <Upload size={20} aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {imported ??
              t(($) => {
                return $.onboarding.sourcesFirst.skills.panelTitle;
              })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {imported
              ? t(($) => {
                  return $.onboarding.sourcesFirst.skills.importedCopy;
                })
              : t(($) => {
                  return $.onboarding.sourcesFirst.skills.panelCopy;
                })}
          </p>
        </div>
      </div>
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
    </OnboardingShell>
  );
}

export function OnboardingSlackPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("slack", openWelcome);
  const connected = flow.draft.slackStatus === "connected";

  return (
    <OnboardingShell
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
      footer={
        <OnboardingFooter
          onBack={flow.goBack}
          onPrimary={
            connected
              ? flow.goNext
              : () => {
                  // Frontend pass: the Slack install round trip replaces this
                  // once the integration step is wired.
                  updateDraft({ slackStatus: "connected" });
                }
          }
          primaryLabel={
            connected
              ? t(($) => {
                  return $.onboarding.sourcesFirst.slack.open;
                })
              : t(($) => {
                  return $.onboarding.sourcesFirst.slack.add;
                })
          }
        />
      }
    >
      {welcomeDialog}
      {connected ? (
        <p
          className="flex items-center gap-2 rounded-xl border border-border p-4 text-sm"
          role="status"
        >
          <Check size={16} aria-hidden="true" />
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.connectedStatus;
          })}
        </p>
      ) : null}
      <aside className="mt-4 rounded-xl border border-border p-4 text-sm">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewChannel;
          })}
        </p>
        <p className="mt-3">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewAsk;
          })}
        </p>
        <p className="mt-2 text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewReply;
          })}
        </p>
      </aside>
      {connected ? null : (
        <div className="mt-3">
          <Button type="button" variant="ghost" onClick={flow.goNext}>
            {t(($) => {
              return $.onboarding.sourcesFirst.common.skip;
            })}
          </Button>
        </div>
      )}
    </OnboardingShell>
  );
}
