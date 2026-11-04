import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { AGENT_SETUP_RESPONSIBILITY_MAX_CHARS } from "@okouai/api-contracts/validators/agent-setup-prompts";
import { Loader2, Wand } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { createSubagentWithSetupThread$ } from "../../signals/okou-page/agents.ts";
import {
  jobsDialogOpen$,
  setJobsDialogOpen$,
  jobsNewName$,
  setJobsNewName$,
  jobsResponsibility$,
  setJobsResponsibility$,
  jobsAvatarUrl$,
  setJobsAvatarUrl$,
  jobsVisibility$,
  setJobsVisibility$,
} from "../../signals/okou-page/jobs-page.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { onDomEventFn } from "../../signals/utils.ts";
import { serializeAvatarSvgConfig } from "../okou-page/avatar-svg-utils.ts";
import { AvatarMaker } from "../okou-page/avatar-maker.tsx";
import { AvatarFromUrl } from "../okou-page/sidebar-shared.tsx";

type Visibility = "public" | "private";

interface CreateAgentInput {
  displayName: string;
  avatarUrl: string;
  visibility: Visibility;
  responsibility: string;
}

/** Keep the dialog and action owner mounted; Base UI bounds the form presence. */
export function CreateAgentDialogContainer() {
  const { t } = useTranslation("agents");
  const open = useGet(jobsDialogOpen$);
  const setDialogOpen = useSet(setJobsDialogOpen$);
  const [createLoadable, createSubagentWithSetupThreadFn] = useLoadableSet(
    createSubagentWithSetupThread$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={creating ? undefined : setDialogOpen}>
      <DialogContent
        closeLabel={t(($) => {
          return $.actions.close;
        })}
        smMaxWidth={480}
        contentClassName="p-0 gap-0 overflow-hidden"
      >
        <CreateAgentDialogForm
          creating={creating}
          onCreate={createSubagentWithSetupThreadFn}
          onCancel={() => {
            setDialogOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreateAgentDialogForm({
  creating,
  onCreate,
  onCancel,
}: {
  creating: boolean;
  onCreate: (input: CreateAgentInput, signal: AbortSignal) => Promise<void>;
  onCancel: () => void;
}) {
  const newName = useGet(jobsNewName$);
  const setNewName = useSet(setJobsNewName$);
  const responsibility = useGet(jobsResponsibility$);
  const setResponsibility = useSet(setJobsResponsibility$);
  const visibility = useGet(jobsVisibility$);
  const setVisibility = useSet(setJobsVisibility$);
  const pageSignal = useGet(pageSignal$);
  const trimmedName = newName.trim();
  const trimmedResponsibility = responsibility.trim();
  const canCreate =
    trimmedName !== "" && trimmedResponsibility !== "" && !creating;
  const handleCreateTeammate = onDomEventFn(async (avatarUrl: string) => {
    if (!canCreate) {
      return;
    }
    await onCreate(
      {
        displayName: trimmedName,
        avatarUrl,
        visibility,
        responsibility: trimmedResponsibility,
      },
      pageSignal,
    );
  });

  return (
    <CreateTeammateDialogContent
      newName={newName}
      onNameChange={setNewName}
      responsibility={responsibility}
      onResponsibilityChange={setResponsibility}
      onConfirm={handleCreateTeammate}
      canCreate={canCreate}
      creating={creating}
      visibility={visibility}
      onVisibilityChange={setVisibility}
      onCancel={onCancel}
    />
  );
}

function CreateAgentAvatarPreview() {
  const { t } = useTranslation("agents");
  const avatarUrl = useGet(jobsAvatarUrl$);
  const setAvatarUrl = useSet(setJobsAvatarUrl$);

  return (
    <div className="flex flex-col items-center pt-10 pb-6 bg-muted/30">
      <AvatarMaker
        onConfirm={(cfg) => {
          setAvatarUrl(serializeAvatarSvgConfig(cfg));
          return Promise.resolve();
        }}
        trigger={(openMaker) => {
          return (
            <button
              type="button"
              onClick={openMaker}
              className="relative rounded-full transition-transform duration-200 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={t(($) => {
                return $.avatar.actions.customize;
              })}
            >
              <AvatarFromUrl
                avatarUrl={avatarUrl}
                alt={t(($) => {
                  return $.list.create.newAgentAlt;
                })}
                className="h-16 w-16 rounded-full object-cover object-top"
              />
              <TooltipProvider delay={200}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="absolute -right-0.5 -bottom-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border">
                        <Wand size={10} />
                      </span>
                    }
                  />
                  <TooltipContent side="bottom">
                    <p className="text-xs">
                      {t(($) => {
                        return $.avatar.actions.customize;
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </button>
          );
        }}
      />
    </div>
  );
}

function AgentVisibilitySelect({
  visibility,
  onVisibilityChange,
  disabled,
}: {
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("agents");
  const visibilityItems = [
    {
      value: "private",
      label: (
        <>
          {t(($) => {
            return $.list.create.visibility.private.label;
          })}{" "}
          <span className="text-muted-foreground">
            {t(($) => {
              return $.list.create.visibility.private.description;
            })}
          </span>
        </>
      ),
    },
    {
      value: "public",
      label: (
        <>
          {t(($) => {
            return $.list.create.visibility.public.label;
          })}{" "}
          <span className="text-muted-foreground">
            {t(($) => {
              return $.list.create.visibility.public.description;
            })}
          </span>
        </>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">
        {t(($) => {
          return $.list.create.visibilityLabel;
        })}
      </span>
      <Select
        items={visibilityItems}
        value={visibility}
        onValueChange={(value, details) => {
          if (value !== "public" && value !== "private") {
            details.cancel();
            return;
          }
          onVisibilityChange(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          className="h-9 w-full"
          aria-label={t(($) => {
            return $.list.create.visibilityLabel;
          })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {visibilityItems.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function CreateAgentFields({
  newName,
  onNameChange,
  responsibility,
  onResponsibilityChange,
  creating,
  visibility,
  onVisibilityChange,
}: {
  newName: string;
  onNameChange: (name: string) => void;
  responsibility: string;
  onResponsibilityChange: (responsibility: string) => void;
  creating: boolean;
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex flex-col gap-4 px-6 py-6">
      <div className="text-center">
        <p className="text-base font-semibold">
          {t(($) => {
            return $.list.create.title;
          })}
        </p>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t(($) => {
            return $.list.create.description;
          })}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="new-agent-name"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.profile.fields.name.label;
          })}
        </label>
        <Input
          id="new-agent-name"
          value={newName}
          onChange={(e) => {
            return onNameChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
            ) {
              // Safari can end composition before the candidate-confirming
              // keydown. Keep that Enter from implicitly submitting the form.
              e.preventDefault();
            }
          }}
          placeholder={t(($) => {
            return $.list.create.namePlaceholder;
          })}
          autoFocus
          disabled={creating}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="new-agent-responsibility"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.list.create.responsibilityLabel;
          })}
        </label>
        <Textarea
          id="new-agent-responsibility"
          value={responsibility}
          onChange={(e) => {
            return onResponsibilityChange(e.target.value);
          }}
          placeholder={t(($) => {
            return $.list.create.responsibilityPlaceholder;
          })}
          maxLength={AGENT_SETUP_RESPONSIBILITY_MAX_CHARS}
          rows={4}
          className="min-h-[96px] resize-y"
          required
          disabled={creating}
        />
      </div>
      <AgentVisibilitySelect
        visibility={visibility}
        onVisibilityChange={onVisibilityChange}
        disabled={creating}
      />
    </div>
  );
}

function CreateTeammateDialogContent({
  newName,
  onNameChange,
  responsibility,
  onResponsibilityChange,
  onConfirm,
  onCancel,
  canCreate,
  creating,
  visibility,
  onVisibilityChange,
}: {
  newName: string;
  onNameChange: (name: string) => void;
  responsibility: string;
  onResponsibilityChange: (responsibility: string) => void;
  onConfirm: (avatarUrl: string) => void;
  onCancel: () => void;
  canCreate: boolean;
  creating: boolean;
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
}) {
  const { t } = useTranslation("agents");
  const avatarUrl = useGet(jobsAvatarUrl$);

  return (
    <>
      <DialogHeader className="sr-only">
        <DialogTitle>
          {t(($) => {
            return $.list.create.title;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.list.create.accessibilityDescription;
          })}
        </DialogDescription>
      </DialogHeader>

      <CreateAgentAvatarPreview />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) {
            onConfirm(avatarUrl);
          }
        }}
      >
        <CreateAgentFields
          newName={newName}
          onNameChange={onNameChange}
          responsibility={responsibility}
          onResponsibilityChange={onResponsibilityChange}
          creating={creating}
          visibility={visibility}
          onVisibilityChange={onVisibilityChange}
        />

        {/* Footer */}
        <div className="flex justify-center gap-3 px-6 pt-4 pb-8">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={creating}
          >
            {t(($) => {
              return $.actions.cancel;
            })}
          </Button>
          <Button type="submit" disabled={!canCreate}>
            {creating ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={14} className="animate-spin" />
                {t(($) => {
                  return $.list.create.creating;
                })}
              </span>
            ) : (
              t(($) => {
                return $.actions.create;
              })
            )}
          </Button>
        </div>
      </form>
    </>
  );
}
