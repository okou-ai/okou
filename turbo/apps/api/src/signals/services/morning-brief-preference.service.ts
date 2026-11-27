import { command } from "ccstate";
import {
  standalonePreference$,
  setStandalonePreferences$,
} from "./proactive-dispatch-state.service";
import {
  loadProactivePreferences$,
  type ProactiveScheduleOwner,
} from "./proactive-member-preferences.service";

export const updateMorningBriefPreference$ = command(
  async (
    { set },
    owner: ProactiveScheduleOwner,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
    const { timezone } = await set(loadProactivePreferences$, owner, signal);
    return await set(
      setStandalonePreferences$,
      {
        owner,
        tasks: ["morning-brief"],
        enabled,
        timezone,
      },
      signal,
    );
  },
);

/** Refresh the schedule for the member's current timezone while preserving a concurrent opt-out. */
export const reconcileExistingMorningBrief$ = command(
  async ({ set }, owner: ProactiveScheduleOwner, signal: AbortSignal) => {
    const preference = await set(
      standalonePreference$,
      owner,
      "morning-brief",
      signal,
    );
    if (!preference.enabled) {
      return "absent";
    }
    const { timezone } = await set(loadProactivePreferences$, owner, signal);
    const saved = await set(
      setStandalonePreferences$,
      {
        owner,
        tasks: ["morning-brief"],
        enabled: true,
        timezone,
        preserveChoice: true,
      },
      signal,
    );
    return saved ? "current" : "conflict";
  },
);
