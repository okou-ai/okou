import { command } from "ccstate";
import { sessionStorageSignals } from "../external/session-storage.ts";

const retiredAcquisitionStorage = [
  sessionStorageSignals("vm0.adAttribution"),
  sessionStorageSignals("okou.impactAttribution"),
] as const;

export const clearRetiredAcquisitionState$ = command(({ set }) => {
  for (const storage of retiredAcquisitionStorage) {
    set(storage.clear$);
  }
});
