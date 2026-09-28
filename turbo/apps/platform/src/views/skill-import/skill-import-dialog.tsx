// The import skills dialog, mounted once in the app shell and opened from the
// workflows page and the composer's plus menu.
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SegmentControl,
  SegmentControlItem,
  buttonVariants,
  cn,
} from "@okouai/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import type { SkillImportProvider } from "../../signals/skill-import/skill-import.ts";
import {
  closeSkillImportDialog$,
  selectSkillImportProvider$,
  setSkillImportPromptExpanded$,
  setSkillImportPromptShown$,
  skillImportDialogOpen$,
  skillImportDialogProvider$,
  skillImportDialogSignals,
  skillImportPromptDisclosure$,
  skillImportPromptShown$,
  startSkillImport$,
} from "../../signals/skill-import/skill-import-dialog.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import {
  ImportedSkillList,
  SkillImportPanel,
  SkillImportStatus,
} from "./skill-import-panel.tsx";

function useProviderName(provider: SkillImportProvider): string {
  const { t } = useTranslation();
  return provider === "codex"
    ? t(($) => {
        return $.onboarding.sourcesFirst.subscription.codex;
      })
    : t(($) => {
        return $.onboarding.sourcesFirst.subscription.claudeCode;
      });
}

/** The tool picker and the prompt written for it. */
function SkillImportPromptSection() {
  const { t } = useTranslation();
  const provider = useGet(skillImportDialogProvider$);
  const selectProvider = useSet(selectSkillImportProvider$);
  const pageSignal = useGet(pageSignal$);
  const providerName = useProviderName(provider);
  const promptShown = useGet(skillImportPromptShown$);
  const setPromptShown = useSet(setSkillImportPromptShown$);

  return (
    <div className="flex flex-col gap-4">
      <SegmentControl
        aria-label={t(($) => {
          return $.workflows.skillImport.providerLabel;
        })}
        value={provider}
        onValueChange={(value: SkillImportProvider) => {
          detach(selectProvider(value, pageSignal), Reason.DomCallback);
        }}
        className="self-start"
      >
        <SegmentControlItem value="claudeCode">
          {t(($) => {
            return $.onboarding.sourcesFirst.subscription.claudeCode;
          })}
        </SegmentControlItem>
        <SegmentControlItem value="codex">
          {t(($) => {
            return $.onboarding.sourcesFirst.subscription.codex;
          })}
        </SegmentControlItem>
      </SegmentControl>
      <SkillImportPanel
        signals={skillImportDialogSignals}
        provider={provider}
        providerName={providerName}
        retry$={startSkillImport$}
        promptToggle={{ shown: promptShown, setShown: setPromptShown }}
      />
    </div>
  );
}

/**
 * A dialog reopened after skills arrived leads with them; the prompt stays one
 * click away for the next batch.
 */
function SkillImportPromptDisclosure({
  expanded,
}: {
  readonly expanded: boolean;
}) {
  const { t } = useTranslation();
  const setExpanded = useSet(setSkillImportPromptExpanded$);

  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="gap-1.5 self-start"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(!expanded);
        }}
      >
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={cn("transition-transform", expanded && "rotate-180")}
        />
        {expanded
          ? t(($) => {
              return $.workflows.skillImport.hidePrompt;
            })
          : t(($) => {
              return $.workflows.skillImport.showPrompt;
            })}
      </Button>
      {expanded ? <SkillImportPromptSection /> : null}
    </div>
  );
}

export function SkillImportDialog() {
  const { t } = useTranslation();
  const open = useGet(skillImportDialogOpen$);
  const close = useSet(closeSkillImportDialog$);
  const disclosure = useGet(skillImportPromptDisclosure$);
  const { imported } = useGet(skillImportDialogSignals.state$);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      {/* The footer's Close is the dialog's one way out besides Escape. */}
      <DialogContent smMaxWidth={640} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.workflows.skillImport.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.workflows.skillImport.description;
            })}
          </DialogDescription>
        </DialogHeader>
        {/* The dialog body is a grid, whose items would otherwise grow to
            the prompt's widest line instead of the dialog's width. */}
        <div className="flex min-w-0 flex-col gap-4">
          {disclosure === "prompt-first" ? (
            <>
              <SkillImportPromptSection />
              {/* Until a skill arrives, the footer says the import is
                  waiting; the list takes the room once there is one. */}
              {imported.length > 0 ? (
                <div className="border-t border-border/60 pt-4">
                  <ImportedSkillList skills={imported} scroll />
                </div>
              ) : null}
            </>
          ) : (
            <>
              <ImportedSkillList skills={imported} scroll />
              <SkillImportPromptDisclosure
                expanded={disclosure === "expanded"}
              />
            </>
          )}
        </div>
        <DialogFooter>
          {disclosure === "prompt-first" ? (
            <div className="mr-auto min-w-0 self-center">
              <SkillImportStatus count={imported.length} />
            </div>
          ) : null}
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              close();
            }}
          >
            {t(($) => {
              return $.workflows.common.close;
            })}
          </Button>
          <Link
            pathname={ROUTES.workflows}
            // Copying the prompt is the primary action until a skill arrives.
            className={buttonVariants({
              variant: imported.length > 0 ? "default" : "outline",
            })}
            onClick={() => {
              close();
            }}
          >
            {t(($) => {
              return $.workflows.skillImport.viewWorkflows;
            })}
          </Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
