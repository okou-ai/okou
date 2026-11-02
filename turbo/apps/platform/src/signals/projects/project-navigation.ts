import { computed } from "ccstate";
import { pathParams$, searchParams$ } from "../route.ts";
import { activeRoute$ } from "../active-route.ts";
export const selectedProjectId$ = computed((get) => {
  const id =
    get(activeRoute$) === "project"
      ? get(pathParams$)?.projectId
      : get(searchParams$).get("project");
  return typeof id === "string" ? id : null;
});
