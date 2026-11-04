import { useLastResolved, useSet } from "ccstate-react";
import { projectCreationAgentId$ } from "../../signals/projects/project-selected-agent.ts";
import { locateProjectFolder$ } from "../../signals/projects/project-navigation.ts";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { Link } from "../router/link.tsx";
export function ProjectReference({
  part,
  className,
}: {
  part: { readonly projectId: string; readonly nameSnapshot: string };
  className?: string;
}) {
  const agent = useLastResolved(projectCreationAgentId$);
  const locate = useSet(locateProjectFolder$);
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
          locate(part.projectId);
        }
      }}
      className={className}
    >
      {part.nameSnapshot}
    </Link>
  );
}
