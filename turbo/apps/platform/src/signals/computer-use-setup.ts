import { command, computed } from "ccstate";
import { searchParams$, updateSearchParams$ } from "./route.ts";

export type ComputerUseSetupStep = "install" | "permissions" | "chat";

export const computerUseSetupStep$ = computed((get): ComputerUseSetupStep => {
  const step = get(searchParams$).get("computerUseStep");
  return step === "permissions" || step === "chat" ? step : "install";
});

export const setComputerUseSetupStep$ = command(
  ({ get, set }, step: ComputerUseSetupStep) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set("computerUseStep", step);
    set(updateSearchParams$, params);
  },
);

export function createComputerUseGuideSignals(owner: string) {
  const computerUseDownloadDialogOpen$ = computed((get) => {
    return get(searchParams$).get("computerUseGuide") === owner;
  });
  const setComputerUseDownloadDialogOpen$ = command(
    ({ get, set }, open: boolean) => {
      const params = new URLSearchParams(get(searchParams$));
      if (open) {
        params.set("computerUseGuide", owner);
        params.set("computerUseStep", "install");
      } else if (params.get("computerUseGuide") === owner) {
        params.delete("computerUseGuide");
        params.delete("computerUseStep");
      }
      set(updateSearchParams$, params);
    },
  );
  return { computerUseDownloadDialogOpen$, setComputerUseDownloadDialogOpen$ };
}
