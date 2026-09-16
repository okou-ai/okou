// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  surfaceVariants,
  Button,
  Card,
  CardContent,
  ToggleButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { AlertTriangle, Wand } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@okouai/ui/components/ui/alert";
import { type Tone, TONE_OPTIONS } from "./tone-constants.ts";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@okouai/core/public-brand";
import { detach, Reason } from "../../signals/utils.ts";
import { UnsavedBar } from "./unsaved-bar.tsx";
import type { Command } from "ccstate";
import { InlineSettingsRow } from "./components/inline-settings-row.tsx";
import {
  AgentDeleteDialog,
  type AgentDeleteCopyTarget,
} from "./components/delete-agent-dialog.tsx";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  serializeAvatarSvgConfig,
  type AvatarSvgConfig,
  type ResolvedAvatarSvgConfig,
} from "./avatar-svg-utils.ts";
import { resolveAvatarSvgConfig } from "./avatar-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import { AvatarMaker } from "./avatar-maker.tsx";
import { AvatarFromUrl } from "./sidebar-shared.tsx";
import {
  type AgentDeleteWorkflow,
  settingsFormDraft$,
  patchSettingsForm$,
  resetSettingsForm$,
  agentDemoteConfirmOpen$,
  setAgentDemoteConfirmOpen$,
} from "../../signals/okou-page/settings/settings-tab.ts";

interface SettingsTabProps {
  agentId: string;
  displayName: string;
  description: string;
  sound: Tone;
  avatarUrl: string | null;
  visibility?: "public" | "private";
  canEditVisibility?: boolean;
  /** Workflows bound to this agent, offered for rescue in the delete dialog. */
  deleteWorkflows?: readonly AgentDeleteWorkflow[];
  deleteWorkflowsState: "loading" | "error" | "ready";
  /** Agents the caller can copy a workflow onto before deleting this agent. */
  deleteCopyTargets?: readonly AgentDeleteCopyTarget[];
  /** Copy a workflow onto another agent before the agent is deleted. */
  onCopyWorkflowBeforeDelete?: (
    workflowId: string,
    toAgentId: string,
  ) => Promise<void>;
  updateSettings$: Command<
    Promise<void>,
    [
      {
        displayName?: string;
        sound: string;
        description: string;
        avatarUrl?: string | null;
        visibility?: "public" | "private";
      },
      AbortSignal,
    ]
  >;
  inputId?: string;
  /** Authoritative identity; undefined keeps protected controls read-only. */
  isDefaultAgent?: boolean;
  /** Callback to delete the agent. */
  onDelete?: () => Promise<void>;
}

function AvatarSettingsControl({
  isDefaultAgent,
  avatarUrl,
  alt,
  onConfirm,
}: {
  isDefaultAgent: boolean | undefined;
  avatarUrl: string | null;
  alt: string;
  onConfirm: (config: AvatarSvgConfig, signal: AbortSignal) => Promise<void>;
}) {
  if (isDefaultAgent !== false) {
    return (
      <AvatarFromUrl
        avatarUrl={avatarUrl}
        alt={alt}
        className="h-12 w-12 shrink-0 rounded-full object-cover object-top"
      />
    );
  }

  // An existing avatar is its own edit entry, so the dashed circle stays
  // exclusive to the empty state and never reads as "add another avatar".
  const resolved = resolveAvatarSvgConfig(avatarUrl);
  return (
    <AvatarMaker
      avatarUrl={avatarUrl}
      onConfirm={onConfirm}
      trigger={
        resolved
          ? (openMaker) => {
              return <AvatarEditButton config={resolved} onClick={openMaker} />;
            }
          : undefined
      }
    />
  );
}

function AvatarEditButton({
  config,
  onClick,
}: {
  config: ResolvedAvatarSvgConfig;
  onClick: () => void;
}) {
  const { t } = useTranslation("agents");
  const label = t(($) => {
    return $.avatar.actions.customize;
  });

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className="relative shrink-0 rounded-full transition-transform duration-200 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={label}
          >
            <AvatarSvgPreview
              config={config}
              className="h-12 w-12 rounded-full border-(length:--border-width-emphasis) border-primary ring-2 ring-primary/20"
            />
            <span className="absolute -right-0.5 -bottom-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border">
              <Wand size={10} />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function resolveAgentName(
  name: string,
  isDefaultAgent: boolean | undefined,
): string {
  if (isDefaultAgent) {
    return DEFAULT_AGENT_DISPLAY_NAME;
  }
  return name;
}

function omitForDefaultAgent<T>(
  value: T,
  isDefaultAgent: boolean | undefined,
): T | undefined {
  if (isDefaultAgent !== false) {
    return undefined;
  }
  return value;
}

function AgentNameControl({
  name,
  isDefaultAgent,
  inputId,
  label,
  placeholder,
  onChange,
}: {
  name: string;
  isDefaultAgent: boolean | undefined;
  inputId: string;
  label: string;
  placeholder: string;
  onChange: (name: string) => void;
}) {
  if (isDefaultAgent !== false) {
    return (
      <p className="flex h-9 items-center text-sm text-foreground">{name}</p>
    );
  }

  return (
    <Input
      id={inputId}
      value={name}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      placeholder={placeholder}
      className="h-9 w-full"
      aria-label={label}
    />
  );
}

function DefaultAgentVisibility({
  isDefaultAgent,
  visibility,
}: {
  isDefaultAgent: boolean | undefined;
  visibility: "public" | "private";
}) {
  const { t } = useTranslation("agents");
  if (isDefaultAgent !== true) {
    return null;
  }
  return (
    <InlineSettingsRow
      label={t(($) => {
        return $.list.create.visibilityLabel;
      })}
      description={t(($) => {
        return $.profile.fields.visibility.defaultDescription;
      })}
    >
      <p className="text-sm text-foreground">
        {visibility === "public"
          ? t(($) => {
              return $.list.tabs.public;
            })
          : t(($) => {
              return $.list.tabs.private;
            })}
      </p>
    </InlineSettingsRow>
  );
}

function willDemoteAgentVisibility(
  canChangeVisibility: boolean,
  initialVisibility: "public" | "private",
  visibility: "public" | "private",
) {
  return (
    canChangeVisibility &&
    initialVisibility === "public" &&
    visibility === "private"
  );
}

export function SettingsTab({
  agentId,
  displayName: resolvedAgentName,
  description: initialDescription,
  sound: initialSound,
  avatarUrl: initialAvatarUrl,
  visibility: initialVisibility = "public",
  canEditVisibility = true,
  updateSettings$,
  inputId = "okou-agent-name",
  isDefaultAgent,
  onDelete,
  deleteWorkflows,
  deleteWorkflowsState,
  deleteCopyTargets = [],
  onCopyWorkflowBeforeDelete,
}: SettingsTabProps) {
  const { t } = useTranslation("agents");
  const presentedAgentName = resolveAgentName(
    resolvedAgentName,
    isDefaultAgent,
  );
  const defaults = {
    name: presentedAgentName,
    description: initialDescription,
    tone: initialSound,
    avatarUrl: initialAvatarUrl,
    visibility: initialVisibility,
  };
  const draft = useGet(settingsFormDraft$);
  const values =
    draft?.agentId === agentId ? { ...defaults, ...draft.patch } : defaults;
  const {
    name: draftAgentName,
    description: desc,
    tone,
    avatarUrl,
    visibility,
  } = values;
  const agentName = resolveAgentName(draftAgentName, isDefaultAgent);
  const isSettingsDirty =
    agentName !== defaults.name ||
    desc !== defaults.description ||
    tone !== defaults.tone ||
    avatarUrl !== defaults.avatarUrl ||
    visibility !== defaults.visibility;
  const patchForm = useSet(patchSettingsForm$);
  const resetForm = useSet(resetSettingsForm$);

  const [settingsLoadable, triggerUpdateSettings] =
    useLoadableSet(updateSettings$);
  const updateSettings = useSet(updateSettings$);
  const saving = settingsLoadable.state === "loading";

  const handleResetSettings = () => {
    resetForm();
  };

  const pageSignal = useGet(pageSignal$);

  const demoteConfirmOpen = useGet(agentDemoteConfirmOpen$);
  const setDemoteConfirmOpen = useSet(setAgentDemoteConfirmOpen$);
  const canChangeVisibility = canEditVisibility && isDefaultAgent === false;
  const willDemoteVisibility = willDemoteAgentVisibility(
    canChangeVisibility,
    initialVisibility,
    visibility,
  );
  const toneCopy = {
    professional: {
      label: t(($) => {
        return $.profile.tones.professional.label;
      }),
      hint: t(($) => {
        return $.profile.tones.professional.hint;
      }),
      user: t(($) => {
        return $.profile.tones.professional.userSample;
      }),
      agent: t(($) => {
        return $.profile.tones.professional.agentSample;
      }),
    },
    friendly: {
      label: t(($) => {
        return $.profile.tones.friendly.label;
      }),
      hint: t(($) => {
        return $.profile.tones.friendly.hint;
      }),
      user: t(($) => {
        return $.profile.tones.friendly.userSample;
      }),
      agent: t(($) => {
        return $.profile.tones.friendly.agentSample;
      }),
    },
    direct: {
      label: t(($) => {
        return $.profile.tones.direct.label;
      }),
      hint: t(($) => {
        return $.profile.tones.direct.hint;
      }),
      user: t(($) => {
        return $.profile.tones.direct.userSample;
      }),
      agent: t(($) => {
        return $.profile.tones.direct.agentSample;
      }),
    },
    supportive: {
      label: t(($) => {
        return $.profile.tones.supportive.label;
      }),
      hint: t(($) => {
        return $.profile.tones.supportive.hint;
      }),
      user: t(($) => {
        return $.profile.tones.supportive.userSample;
      }),
      agent: t(($) => {
        return $.profile.tones.supportive.agentSample;
      }),
    },
  } satisfies Record<
    Tone,
    { label: string; hint: string; user: string; agent: string }
  >;

  const runSaveSettings = () => {
    detach(
      (async () => {
        await triggerUpdateSettings(
          {
            displayName: omitForDefaultAgent(agentName, isDefaultAgent),
            description: desc,
            sound: tone,
            avatarUrl: omitForDefaultAgent(avatarUrl, isDefaultAgent),
            ...(canChangeVisibility ? { visibility } : {}),
          },
          pageSignal,
        );
        toast.success(
          t(($) => {
            return $.profile.saved;
          }),
        );
      })(),
      Reason.DomCallback,
    );
  };

  const handleSaveSettings = () => {
    if (willDemoteVisibility) {
      setDemoteConfirmOpen(true);
      return;
    }
    runSaveSettings();
  };

  return (
    <>
      <div className="mx-auto max-w-[900px]">
        <Card className={surfaceVariants({ className: "overflow-hidden" })}>
          <CardContent className="p-4 sm:p-5">
            <InlineSettingsRow
              label={t(($) => {
                return $.profile.fields.avatar.label;
              })}
              description={
                isDefaultAgent
                  ? undefined
                  : t(($) => {
                      return $.profile.fields.avatar.description;
                    })
              }
              wideControls
            >
              <div className="min-w-0 w-full">
                <div className="flex flex-wrap gap-2 items-center">
                  <AvatarSettingsControl
                    isDefaultAgent={isDefaultAgent}
                    avatarUrl={avatarUrl}
                    alt={resolvedAgentName}
                    onConfirm={async (cfg, signal) => {
                      const newAvatarUrl = serializeAvatarSvgConfig(cfg);
                      patchForm({
                        agentId,
                        patch: { avatarUrl: newAvatarUrl },
                      });
                      await updateSettings(
                        {
                          displayName: omitForDefaultAgent(
                            agentName,
                            isDefaultAgent,
                          ),
                          description: desc,
                          sound: tone,
                          avatarUrl: newAvatarUrl,
                          ...(canChangeVisibility ? { visibility } : {}),
                        },
                        signal,
                      );
                      signal.throwIfAborted();
                      toast.success(
                        t(($) => {
                          return $.profile.saved;
                        }),
                      );
                    }}
                  />
                </div>
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label={t(($) => {
                return $.profile.fields.name.label;
              })}
              description={omitForDefaultAgent(
                t(($) => {
                  return $.profile.fields.name.description;
                }),
                isDefaultAgent,
              )}
              wideControls
            >
              <div className="min-w-0 w-full">
                <AgentNameControl
                  name={agentName}
                  isDefaultAgent={isDefaultAgent}
                  inputId={inputId}
                  label={t(($) => {
                    return $.profile.fields.name.label;
                  })}
                  placeholder={t(($) => {
                    return $.profile.fields.name.placeholder;
                  })}
                  onChange={(name) => {
                    patchForm({ agentId, patch: { name } });
                  }}
                />
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label={t(($) => {
                return $.profile.fields.description.label;
              })}
              description={t(($) => {
                return $.profile.fields.description.description;
              })}
              wideControls
            >
              <div className="min-w-0 w-full">
                <Textarea
                  id={`${inputId}-description`}
                  value={desc}
                  onChange={(e) => {
                    return patchForm({
                      agentId,
                      patch: { description: e.target.value },
                    });
                  }}
                  placeholder={t(($) => {
                    return $.profile.fields.description.placeholder;
                  })}
                  rows={3}
                  className="min-h-[72px] resize-y"
                  aria-label={t(($) => {
                    return $.profile.fields.description.label;
                  })}
                />
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label={t(($) => {
                return $.profile.fields.tone.label;
              })}
              description={t(($) => {
                return $.profile.fields.tone.description;
              })}
              wideControls
            >
              <div
                className="min-w-0 w-full flex flex-col gap-3"
                role="group"
                aria-label={t(
                  ($) => {
                    return $.profile.fields.tone.accessibilityLabel;
                  },
                  { agentName: presentedAgentName },
                )}
              >
                <div
                  className="grid w-full grid-cols-2 gap-2"
                  role="group"
                  aria-label={t(($) => {
                    return $.profile.fields.tone.groupLabel;
                  })}
                >
                  {TONE_OPTIONS.map((opt) => {
                    return (
                      <ToggleButton
                        key={opt}
                        layout="tile"
                        selected={tone === opt}
                        onClick={() => {
                          return patchForm({
                            agentId,
                            patch: { tone: opt },
                          });
                        }}
                      >
                        {toneCopy[opt].label}
                      </ToggleButton>
                    );
                  })}
                </div>
                <div
                  data-slot="tone-preview"
                  className="rounded-lg bg-muted/30 px-3 py-2 w-full border-(length:--border-width-surface) border-solid border-surface-border"
                  key={tone}
                >
                  <p className="text-xs text-muted-foreground italic min-h-[1.25rem] leading-relaxed">
                    {toneCopy[tone].hint}
                  </p>
                  <div className="my-2 border-t border-border/30" />
                  <div className="flex flex-col gap-1.5 pb-1.5">
                    <div className="flex justify-end">
                      <div
                        data-slot="tone-preview-user-message"
                        className="bg-gray-100/95 text-foreground max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed transition-colors duration-200"
                      >
                        {toneCopy[tone].user}
                      </div>
                    </div>
                    <div className="flex justify-start">
                      <div className="max-w-[85%] rounded-xl px-3 py-2 text-sm text-foreground leading-relaxed transition-colors duration-200 bg-transparent border-none border-current">
                        {toneCopy[tone].agent}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </InlineSettingsRow>
            <DefaultAgentVisibility
              isDefaultAgent={isDefaultAgent}
              visibility={initialVisibility}
            />
            {canChangeVisibility && (
              <InlineSettingsRow
                label={t(($) => {
                  return $.profile.fields.visibility.label;
                })}
                description={t(($) => {
                  return $.profile.fields.visibility.description;
                })}
              >
                <Switch
                  checked={visibility === "public"}
                  onCheckedChange={(checked) => {
                    return patchForm({
                      agentId,
                      patch: { visibility: checked ? "public" : "private" },
                    });
                  }}
                  aria-label={t(($) => {
                    return $.profile.fields.visibility.label;
                  })}
                />
              </InlineSettingsRow>
            )}
          </CardContent>
        </Card>

        {isDefaultAgent === false && onDelete && (
          <AgentDeleteDialog
            agentId={agentId}
            resolvedAgentName={presentedAgentName}
            onDelete={onDelete}
            deleteWorkflows={deleteWorkflows}
            deleteWorkflowsState={deleteWorkflowsState}
            deleteCopyTargets={deleteCopyTargets}
            onCopyWorkflowBeforeDelete={onCopyWorkflowBeforeDelete}
          />
        )}
      </div>

      {isSettingsDirty && (
        <UnsavedBar
          onDiscard={handleResetSettings}
          onSave={handleSaveSettings}
          saving={saving}
          message={t(($) => {
            return $.unsaved.message;
          })}
          discardLabel={t(($) => {
            return $.actions.discard;
          })}
          saveLabel={t(($) => {
            return $.actions.save;
          })}
        />
      )}

      <Dialog
        open={isDefaultAgent === false && demoteConfirmOpen}
        onOpenChange={setDemoteConfirmOpen}
      >
        <DialogContent
          closeLabel={t(($) => {
            return $.actions.close;
          })}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                ($) => {
                  return $.profile.makePrivate.title;
                },
                { agentName: presentedAgentName },
              )}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.profile.makePrivate.description;
              })}
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle size={16} />
            <AlertTitle>
              {t(($) => {
                return $.profile.makePrivate.warningTitle;
              })}
            </AlertTitle>
            <AlertDescription>
              {t(
                ($) => {
                  return $.profile.makePrivate.warningDescription;
                },
                { agentName: presentedAgentName },
              )}
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDemoteConfirmOpen(false);
              }}
            >
              {t(($) => {
                return $.actions.cancel;
              })}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDemoteConfirmOpen(false);
                runSaveSettings();
              }}
            >
              {saving
                ? t(($) => {
                    return $.actions.saving;
                  })
                : t(($) => {
                    return $.profile.makePrivate.confirm;
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
