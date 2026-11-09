import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  inlineReferenceVariants,
} from "@okouai/ui";
import { locateProject$ } from "../../signals/projects/project-navigation.ts";
import { projects$, projectsLoaded$ } from "../../signals/projects/projects.ts";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { Link } from "../router/link.tsx";

// A deleted Project keeps the name it had when it was mentioned, but it can no
// longer be opened, so it renders as a static, muted reference.
function UnavailableProjectReference({ name }: { name: string }) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.projects.deleted;
  });
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={`${name}, ${label}`}
              data-project-reference-unavailable=""
              className={inlineReferenceVariants({
                className:
                  "min-w-0 max-w-[240px] border-dashed bg-transparent text-muted-foreground line-through decoration-muted-foreground/60 dark:bg-transparent",
              })}
            >
              <span className="truncate">{name}</span>
            </span>
          }
        />
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ProjectReference({
  part,
  className,
}: {
  part: { readonly projectId: string; readonly nameSnapshot: string };
  className?: string;
}) {
  const locate = useSet(locateProject$);
  const loaded = useGet(projectsLoaded$);
  const exists = useGet(projects$).some((project) => {
    return project.id === part.projectId;
  });
  // Until the Projects are synced, a missing Project is not known to be gone.
  if (loaded && !exists) {
    return <UnavailableProjectReference name={part.nameSnapshot} />;
  }
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
          locate(part.projectId);
        }
      }}
      className={className}
    >
      {part.nameSnapshot}
    </Link>
  );
}
