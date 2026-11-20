import { command } from "ccstate";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";

export const setupAgentsPage$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  // Previously issued settings and checkout links can use the old Agents path.
  if (params.size === 0) {
    params.set("settings", "my-okou");
  }
  set(detachedNavigateTo$, "/", { searchParams: params, replace: true });
});
