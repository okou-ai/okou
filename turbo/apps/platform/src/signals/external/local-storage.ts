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

/** Read the current shared storage bytes, including writes from other tabs. */
export function listLocalStorageEntriesForTest(prefix: string): readonly {
  readonly key: string;
  readonly value: string;
}[] {
  const fullPrefix = `${LOCAL_STORAGE_KEY_PREFIX}${prefix}`;
  const entries: { key: string; value: string }[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const fullKey = localStorage.key(index);
    if (!fullKey?.startsWith(fullPrefix)) {
      continue;
    }
    const value = localStorage.getItem(fullKey);
    if (value !== null) {
      entries.push({
        key: fullKey.slice(LOCAL_STORAGE_KEY_PREFIX.length),
        value,
      });
    }
  }
  return entries;
}
