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
  skillImportDialogOpen$,
  skillImportDialogProvider$,
  skillImportDialogSignals,
  skillImportPromptDisclosure$,
  startSkillImport$,
} from "../../signals/skill-import/skill-import-dialog.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ImportedSkillList, SkillImportPanel } from "./skill-import-panel.tsx";

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
        providerName={providerName}
        retry$={startSkillImport$}
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
        {disclosure === "prompt-first" ? (
          <>
            <SkillImportPromptSection />
            <ImportedSkillList skills={imported} />
          </>
        ) : (
          <>
            <ImportedSkillList skills={imported} />
            <SkillImportPromptDisclosure expanded={disclosure === "expanded"} />
          </>
        )}
        <DialogFooter>
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
            className={buttonVariants({ variant: "default" })}
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
