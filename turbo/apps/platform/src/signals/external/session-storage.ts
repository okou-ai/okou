import { state } from "ccstate";
import { createStorageSignals } from "./storage-signals.ts";

const registeredSessionStorageKeys$ = state<Set<string> | null>(null);

export function sessionStorageSignals(key: string) {
  return createStorageSignals(
    () => {
      return sessionStorage;
    },
    registeredSessionStorageKeys$,
    `okou_${key}`,
  );
}
