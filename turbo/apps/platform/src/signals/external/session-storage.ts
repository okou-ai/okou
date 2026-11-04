import { state } from "ccstate";
import {
  createResetStorageForTest,
  createStorageSignals,
} from "./storage-signals.ts";

const registeredSessionStorageKeys$ = state<Set<string> | null>(null);
const SESSION_STORAGE_KEY_PREFIX = "okou_";

type UnprefixedSessionStorageKey<Key extends string> =
  Key extends `${typeof SESSION_STORAGE_KEY_PREFIX}${string}` ? never : Key;

export const resetSessionStorageForTest$ = createResetStorageForTest(() => {
  return sessionStorage;
}, registeredSessionStorageKeys$);

export function sessionStorageSignals<const Key extends string>(
  key: UnprefixedSessionStorageKey<Key>,
) {
  return createStorageSignals(
    () => {
      return sessionStorage;
    },
    registeredSessionStorageKeys$,
    `${SESSION_STORAGE_KEY_PREFIX}${key}`,
  );
}
