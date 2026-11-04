import { computed } from "ccstate";
import { searchParams$ } from "../route.ts";
import { teamsClient$, teamsOrgData$ } from "./teams.ts";
import { teamsTargetState } from "./teams-connect-context.ts";

export const teamsConnectPageState$ = computed(async (get) => {
  const params = get(searchParams$);
  const { assertCurrent } = await get(teamsClient$);
  const data = await get(teamsOrgData$);
  assertCurrent();
  const target = teamsTargetState(params, data);
  const connected = data.isConnected;
  const success = connected && (target === "none" || target === "match");
  return {
    data,
    target,
    connected,
    success,
  };
});

export type TeamsConnectPageState = Awaited<
  ReturnType<typeof teamsConnectPageState$.read>
>;
