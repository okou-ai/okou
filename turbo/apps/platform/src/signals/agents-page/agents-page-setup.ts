import { command } from "ccstate";
import { detachedNavigateTo$, hash$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

export const setupAgentsPage$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  // Previously issued settings and checkout links can use the old Agents path.
  if (params.size === 0) {
    params.set("settings", "my-okou");
  }
  set(detachedNavigateTo$, "/", {
    searchParams: params,
    hash: get(hash$),
    replace: true,
  });
});

// Bookmarks for profiles and instructions now open personal settings.
export const redirectLegacyAgentDetail$ = command(({ get, set }) => {
  const tab = get(searchParams$).get("tab");
  if (tab === "authorization" || tab === null) {
    set(detachedNavigateTo$, ROUTES.connectors, { replace: true });
    return;
  }

  const params = new URLSearchParams({ settings: "my-okou" });
  if (tab === "instructions" || tab === "profile") {
    params.set("focus", "instructions");
  }
  set(detachedNavigateTo$, ROUTES.home, {
    searchParams: params,
    replace: true,
  });
});
