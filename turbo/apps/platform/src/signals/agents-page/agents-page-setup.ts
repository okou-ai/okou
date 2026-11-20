import { MORNING_BRIEF_PREFERENCES_FOCUS } from "@okouai/api-contracts/validators/morning-brief-preference";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { command } from "ccstate";

export const setupAgentsPage$ = command(({ get, set }) => {
  const params = get(searchParams$);
  const morningBrief =
    params.get("settings") === "preference" &&
    params.get("focus") === MORNING_BRIEF_PREFERENCES_FOCUS;
  set(detachedNavigateTo$, "/", {
    searchParams: morningBrief
      ? new URLSearchParams({
          settings: "preference",
          focus: MORNING_BRIEF_PREFERENCES_FOCUS,
        })
      : new URLSearchParams({ settings: "my-okou" }),
    replace: true,
  });
});
