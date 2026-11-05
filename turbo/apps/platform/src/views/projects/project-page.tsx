import { useGet } from "ccstate-react";
import { selectedProjectId$ } from "../../signals/projects/project-navigation.ts";
import { projects$ } from "../../signals/projects/projects.ts";
import { AgentComposerPage } from "../okou-page/agent-chat-page.tsx";

export function ProjectPage() {
  const projectId = useGet(selectedProjectId$);
  const project =
    useGet(projects$).find((item) => {
      return item.id === projectId;
    }) ?? null;
  return <AgentComposerPage project={project} />;
}
