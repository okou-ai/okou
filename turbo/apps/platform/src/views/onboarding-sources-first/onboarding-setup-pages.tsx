import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, Upload, UserPlus } from "lucide-react";
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  RadioGroup,
  surfaceVariants,
  cn,
} from "@okouai/ui";
import {
  nextSourcesFirstStep,
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
import {
  OnboardingChoiceCard,
  OnboardingIllustration,
  OnboardingRow,
  OnboardingRowStack,
  ProductMark,
} from "./onboarding-step-parts.tsx";
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
      canvas
      wide
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
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {INDUSTRY_IDS.map((id) => {
          return (
            <OnboardingChoiceCard
              key={id}
              value={id}
              selected={flow.draft.industry === id}
              title={t(($) => {
                return $.onboarding.sourcesFirst.industries[id].name;
              })}
              description={t(($) => {
                return $.onboarding.sourcesFirst.industries[id].summary;
              })}
            />
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
      canvas
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
      <OnboardingRowStack>
        <OnboardingRow
          icon={UserPlus}
          title={t(($) => {
            return $.onboarding.sourcesFirst.team.label;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.team.note;
          })}
        >
          <div className="flex w-full gap-2 sm:w-[420px]">
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
            <Button type="button" onClick={invite}>
              {t(($) => {
                return $.onboarding.sourcesFirst.team.invite;
              })}
            </Button>
          </div>
        </OnboardingRow>
        {flow.draft.invites.length > 0 ? (
          <Card className="divide-y divide-border">
            {flow.draft.invites.map((invitee) => {
              return (
                <div
                  key={invitee}
                  className="flex items-center gap-3 px-4 py-3.5"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
                    {invitee.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {invitee}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Check size={14} aria-hidden="true" />
                    {t(($) => {
                      return $.onboarding.sourcesFirst.team.invited;
                    })}
                  </span>
                </div>
              );
            })}
          </Card>
        ) : null}
      </OnboardingRowStack>
    </OnboardingShell>
  );
}

export function OnboardingExperiencePage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("experience", openWelcome);

  // The answer decides the branch, so the next step is resolved from the new
  // answer instead of the one this render was built from.
  const choose = (experienced: boolean): void => {
    updateDraft({ experienced });
    const next = nextSourcesFirstStep("experience", flow.flow, experienced);
    if (next) {
      flow.goTo(next);
      return;
    }
    openWelcome();
  };

  return (
    <OnboardingShell
      canvas
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
      <OnboardingRowStack>
        <OnboardingRow
          icon={
            <OnboardingIllustration
              name="workflow-default"
              alt={t(($) => {
                return $.onboarding.sourcesFirst.experience.yes;
              })}
            />
          }
          title={t(($) => {
            return $.onboarding.sourcesFirst.experience.yes;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.experience.yesCopy;
          })}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              choose(true);
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.experience.choose;
            })}
          </Button>
        </OnboardingRow>
        <OnboardingRow
          icon={
            <OnboardingIllustration
              name="explore"
              alt={t(($) => {
                return $.onboarding.sourcesFirst.experience.no;
              })}
            />
          }
          title={t(($) => {
            return $.onboarding.sourcesFirst.experience.no;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.experience.noCopy;
          })}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              choose(false);
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.experience.choose;
            })}
          </Button>
        </OnboardingRow>
      </OnboardingRowStack>
    </OnboardingShell>
  );
}

export function OnboardingSubscriptionPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("subscription", openWelcome);
  const connected = flow.draft.providerConnected;

  const providerRow = (
    provider: "codex" | "claudeCode",
    title: string,
  ): ReturnType<typeof OnboardingRow> => {
    const active = connected && flow.draft.provider === provider;
    return (
      <OnboardingRow
        icon={
          provider === "codex" ? (
            <ProductMark name="openai" alt={title} invertInDarkMode />
          ) : (
            <ProductMark name="claude-code" alt={title} />
          )
        }
        title={title}
        description={t(($) => {
          return $.onboarding.sourcesFirst.subscription.rowCopy;
        })}
        status={
          active ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check size={14} aria-hidden="true" />
              {t(($) => {
                return $.onboarding.sourcesFirst.subscription.connected;
              })}
            </span>
          ) : null
        }
      >
        <Button
          type="button"
          variant={active ? "outline" : "secondary"}
          disabled={active}
          onClick={() => {
            // Frontend pass: the personal model-provider connect flow is wired
            // in the follow-up that adds the onboarding endpoints.
            updateDraft({ provider, providerConnected: true });
          }}
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.subscription.connect;
          })}
        </Button>
      </OnboardingRow>
    );
  };

  return (
    <OnboardingShell
      canvas
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.subscription.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.subscription.copy;
      })}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={flow.goBack}>
            {t(($) => {
              return $.onboarding.sourcesFirst.common.back;
            })}
          </Button>
          <div className="flex items-center gap-2">
            {connected ? null : (
              <Button type="button" variant="ghost" onClick={flow.goNext}>
                {t(($) => {
                  return $.onboarding.sourcesFirst.common.skip;
                })}
              </Button>
            )}
            <Button
              type="button"
              size="lg"
              disabled={!connected}
              onClick={flow.goNext}
            >
              {t(($) => {
                return $.onboarding.sourcesFirst.common.continue;
              })}
            </Button>
          </div>
        </div>
      }
    >
      {welcomeDialog}
      <OnboardingRowStack>
        {providerRow(
          "codex",
          t(($) => {
            return $.onboarding.sourcesFirst.subscription.codex;
          }),
        )}
        {providerRow(
          "claudeCode",
          t(($) => {
            return $.onboarding.sourcesFirst.subscription.claudeCode;
          }),
        )}
      </OnboardingRowStack>
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

export function OnboardingSkillsPage() {
  const { t } = useTranslation();
  const { welcomeDialog, openWelcome } = useWelcomeHandoff();
  const flow = useSourcesFirstFlow("skills", openWelcome);
  const updateUi = useSet(updateSourcesFirstUi$);
  const imported = flow.draft.importedWorkflowName;

  return (
    <OnboardingShell
      canvas
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
        <div className="flex w-full items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={flow.goBack}>
            {t(($) => {
              return $.onboarding.sourcesFirst.common.back;
            })}
          </Button>
          <div className="flex items-center gap-2">
            {imported ? null : (
              <Button type="button" variant="ghost" onClick={flow.goNext}>
                {t(($) => {
                  return $.onboarding.sourcesFirst.common.skip;
                })}
              </Button>
            )}
            <Button
              type="button"
              size="lg"
              disabled={imported === null}
              onClick={flow.goNext}
            >
              {t(($) => {
                return $.onboarding.sourcesFirst.common.continue;
              })}
            </Button>
          </div>
        </div>
      }
    >
      {welcomeDialog}
      <OnboardingRow
        icon={
          imported ? (
            <OnboardingIllustration name="workflow-default" alt={imported} />
          ) : (
            Upload
          )
        }
        title={
          imported ??
          t(($) => {
            return $.onboarding.sourcesFirst.skills.panelTitle;
          })
        }
        description={
          imported
            ? t(($) => {
                return $.onboarding.sourcesFirst.skills.importedCopy;
              })
            : t(($) => {
                return $.onboarding.sourcesFirst.skills.panelCopy;
              })
        }
      >
        {/* A label opens the file picker without reaching for the DOM. */}
        <Button
          variant="secondary"
          render={<label htmlFor={SKILL_FILE_INPUT_ID} />}
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.import;
          })}
        </Button>
      </OnboardingRow>
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
      canvas
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
        <div className="flex w-full items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={flow.goBack}>
            {t(($) => {
              return $.onboarding.sourcesFirst.common.back;
            })}
          </Button>
          <div className="flex items-center gap-2">
            {connected ? null : (
              <Button type="button" variant="ghost" onClick={flow.goNext}>
                {t(($) => {
                  return $.onboarding.sourcesFirst.common.skip;
                })}
              </Button>
            )}
            <Button type="button" size="lg" onClick={flow.goNext}>
              {connected
                ? t(($) => {
                    return $.onboarding.sourcesFirst.slack.open;
                  })
                : t(($) => {
                    return $.onboarding.sourcesFirst.common.continue;
                  })}
            </Button>
          </div>
        </div>
      }
    >
      {welcomeDialog}
      <OnboardingRowStack>
        <OnboardingRow
          icon={
            <ProductMark
              name="slack"
              alt={t(($) => {
                return $.onboarding.sourcesFirst.slack.rowTitle;
              })}
            />
          }
          title={t(($) => {
            return $.onboarding.sourcesFirst.slack.rowTitle;
          })}
          description={t(($) => {
            return $.onboarding.sourcesFirst.slack.copy;
          })}
          status={
            connected ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Check size={14} aria-hidden="true" />
                {t(($) => {
                  return $.onboarding.sourcesFirst.slack.connectedStatus;
                })}
              </span>
            ) : null
          }
        >
          <Button
            type="button"
            variant={connected ? "outline" : "secondary"}
            disabled={connected}
            onClick={() => {
              // Frontend pass: the Slack install round trip replaces this once
              // the integration step is wired.
              updateDraft({ slackStatus: "connected" });
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.add;
            })}
          </Button>
        </OnboardingRow>
        <Card className="p-4">
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
          <p className="mt-2 rounded-lg bg-muted/50 p-3 text-sm text-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.previewReply;
            })}
          </p>
        </Card>
      </OnboardingRowStack>
    </OnboardingShell>
  );
}
