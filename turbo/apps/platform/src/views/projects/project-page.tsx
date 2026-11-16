import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Archive } from "lucide-react";
import { Button } from "@okouai/ui";
import { AgentComposerPage } from "../okou-page/agent-chat-page.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { selectedProjectId$ } from "../../signals/projects/project-navigation.ts";
import {
  projectArchiveOperation$,
  projectArchiveTargetId$,
  projects$,
} from "../../signals/projects/projects.ts";
import { setProjectArchivedWithFeedback$ } from "../../signals/projects/project-ui.ts";
import { detach, isAbortError, Reason } from "../../signals/utils.ts";

function ProjectArchiveBanner({
  projectId,
}: {
  readonly projectId: string | null | undefined;
}) {
  const { t } = useTranslation();
  const project = useGet(projects$).find((item) => {
    return item.id === projectId;
  });
  const targetId = useGet(projectArchiveTargetId$);
  const operation = useLoadable(projectArchiveOperation$);
  const signal = useGet(pageSignal$);
  const setArchived = useSet(setProjectArchivedWithFeedback$);
  if (!project?.archivedAt) {
    return null;
  }
  const pending = operation.state === "loading";
  return (
    <div className="shrink-0 border-b border-border bg-muted px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p
          role="status"
          className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground"
        >
          <Archive size={16} className="shrink-0" aria-hidden="true" />
          {t(($) => {
            return $.projects.archiveBanner;
          })}
        </p>
        <Button
          variant="neutral"
          size="sm"
          disabled={pending}
          aria-busy={pending}
          onClick={() => {
            detach(setArchived(project.id, false, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.projects.restore;
          })}
        </Button>
      </div>
      {targetId === project.id &&
        operation.state === "hasError" &&
        !isAbortError(operation.error) && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {t(($) => {
              return $.projects.restoreError;
            })}
          </p>
        )}
    </div>
  );
}

export function ProjectPage() {
  const projectId = useGet(selectedProjectId$);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectArchiveBanner projectId={projectId} />
      <AgentComposerPage />
    </div>
  );
}
