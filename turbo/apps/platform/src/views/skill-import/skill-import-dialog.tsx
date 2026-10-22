// The import skills dialog, mounted once in the app shell and opened from the
// workflows page and the composer's plus menu.
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
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
} from "@okouai/ui";
import { ROUTES } from "../../signals/route-paths.ts";
import type { SkillImportProvider } from "../../signals/skill-import/skill-import.ts";
import {
  closeSkillImportDialog$,
  selectSkillImportProvider$,
  setSkillImportPromptShown$,
  skillImportDialogOpen$,
  skillImportDialogProvider$,
  skillImportDialogSignals$,
  skillImportPromptShown$,
} from "../../signals/skill-import/skill-import-dialog.ts";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { Link } from "../router/link.tsx";
import {
  SkillImportResults,
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
  const providerName = useProviderName(provider);
  const promptShown = useGet(skillImportPromptShown$);
  const setPromptShown = useSet(setSkillImportPromptShown$);
  const signals = useGet(skillImportDialogSignals$);

  return (
    <div className="flex flex-col gap-4">
      <SegmentControl
        aria-label={t(($) => {
          return $.workflows.skillImport.providerLabel;
        })}
        value={provider}
        onValueChange={(value: SkillImportProvider) => {
          selectProvider(value);
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
        signals={signals}
        provider={provider}
        providerName={providerName}
        promptToggle={{ shown: promptShown, setShown: setPromptShown }}
      />
    </div>
  );
}

function SkillImportDialogContent() {
  const { t } = useTranslation();
  const close = useSet(closeSkillImportDialog$);
  const signals = useGet(skillImportDialogSignals$);
  const bindDialog = useSet(signals.dialogRef$);
  const results = useLoadable(signals.imported$);
  const count = results.state === "hasData" ? results.data.length : 0;

  return (
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
      <div ref={bindDialog} className="flex min-w-0 flex-col gap-4">
        <SkillImportPromptSection />
        {/* Until a skill arrives, the footer says the import is waiting;
              the list takes the room once there is one. */}
        {results.state !== "hasData" || count > 0 ? (
          <div className="border-t border-border/60 pt-4">
            <SkillImportResults signals={signals} scroll />
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <div className="mr-auto min-w-0 self-center">
          {results.state === "hasData" ? (
            <SkillImportStatus count={count} />
          ) : null}
        </div>
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
            variant: count > 0 ? "default" : "outline",
          })}
          onClick={(event) => {
            if (shouldHandleLinkClick(event)) {
              close();
            }
          }}
        >
          {t(($) => {
            return $.workflows.skillImport.viewWorkflows;
          })}
        </Link>
      </DialogFooter>
    </DialogContent>
  );
}

export function SkillImportDialog() {
  const open = useGet(skillImportDialogOpen$);
  const close = useSet(closeSkillImportDialog$);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      {open ? <SkillImportDialogContent /> : null}
    </Dialog>
  );
}
