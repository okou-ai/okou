import { state } from "ccstate";
import {
  createResetStorageForTest,
  createStorageSignals,
} from "./storage-signals.ts";

const registeredLocalStorageKeys$ = state<Set<string> | null>(null);
const LOCAL_STORAGE_KEY_PREFIX = "okou_";

type UnprefixedLocalStorageKey<Key extends string> =
  Key extends `${typeof LOCAL_STORAGE_KEY_PREFIX}${string}` ? never : Key;

export const resetLocalStorageForTest$ = createResetStorageForTest(() => {
  return localStorage;
}, registeredLocalStorageKeys$);

export function localStorageSignals<const Key extends string>(
  key: UnprefixedLocalStorageKey<Key>,
) {
  return createStorageSignals(
    () => {
      return localStorage;
    },
    registeredLocalStorageKeys$,
    `${LOCAL_STORAGE_KEY_PREFIX}${key}`,
  );
}
