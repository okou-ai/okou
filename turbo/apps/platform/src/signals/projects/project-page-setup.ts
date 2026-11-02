import { hydrateProjects$ } from "./projects.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { ProjectPage } from "../../views/projects/project-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
export const setupProjectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(hydrateProjects$, signal);
    signal.throwIfAborted();
    set(updatePage$, createElement(ProjectPage), "sidebar");
    await set(hideAppSkeleton$, signal);
  },
);
