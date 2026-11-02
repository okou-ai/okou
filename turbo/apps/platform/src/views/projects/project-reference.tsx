import { useLastResolved, useSet, useGet } from "ccstate-react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { useTranslation } from "react-i18next";
import { projects$ } from "../../signals/projects/projects.ts";
import { projectCreationAgentId$ } from "../../signals/projects/project-selected-agent.ts";
import { expandProject$ } from "../../signals/projects/project-folders.ts";
import { setSidebarExpanded$ } from "../../signals/okou-page/nav.ts";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { Link } from "../router/link.tsx";
export function ProjectReference({
  part,
  className,
}: {
  part: { readonly projectId: string; readonly nameSnapshot: string };
  className?: string;
}) {
  const { t } = useTranslation();
  const projects = useGet(projects$);
  const agent = useLastResolved(projectCreationAgentId$);
  const expand = useSet(expandProject$);
  const sidebar = useSet(setSidebarExpanded$);
  return (
    <Link
      pathname="/projects/:projectId"
      options={{
        pathParams: { projectId: part.projectId },
        searchParams: agent
          ? new URLSearchParams({ projectAgent: agent })
          : undefined,
      }}
      onClick={(event) => {
        if (shouldHandleLinkClick(event)) {
          // The mention locates a folder without leaving the conversation.
          event.preventDefault();
          if (
            !projects.some((project) => {
              return project.id === part.projectId;
            })
          ) {
            toast.error(
              t(($) => {
                return $.projects.unavailable;
              }),
            );
            return;
          }
          expand(part.projectId);
          sidebar(true);
        }
      }}
      className={className}
    >
      {part.nameSnapshot}
    </Link>
  );
}
