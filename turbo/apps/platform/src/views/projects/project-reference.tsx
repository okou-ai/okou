import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { useGet, useSet } from "ccstate-react";
import { locateProject$ } from "../../signals/projects/project-navigation.ts";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { Link } from "../router/link.tsx";
export function ProjectReference({
  part,
  className,
}: {
  part: { readonly projectId: string; readonly nameSnapshot: string };
  className?: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const locate = useSet(locateProject$);
  return (
    <Link
      pathname="/projects/:projectId"
      options={{
        pathParams: { projectId: part.projectId },
      }}
      onClick={(event) => {
        if (shouldHandleLinkClick(event)) {
          // The mention locates the Project without leaving the conversation.
          event.preventDefault();
          detach(locate(part.projectId, pageSignal), Reason.DomCallback);
        }
      }}
      className={className}
    >
      {part.nameSnapshot}
    </Link>
  );
}
