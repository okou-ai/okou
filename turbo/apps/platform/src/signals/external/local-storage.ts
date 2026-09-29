import { command, state } from "ccstate";
import { throwIfAbort } from "../utils.ts";
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

// Delivery intents use independent keys so concurrent tabs never rewrite an
// account-wide JSON array. This is the sole direct-browser-storage boundary.
export function readBrowserLocalStorage(
  key: string,
): string | null | undefined {
  // eslint-disable-next-line no-restricted-syntax -- Browser privacy settings may deny synchronous storage reads.
  try {
    return localStorage.getItem(key);
  } catch (error) {
    throwIfAbort(error);
    return undefined;
  }
}

export function serializeBrowserStorage(value: unknown): string | null {
  // eslint-disable-next-line no-restricted-syntax -- Serialization failure must prevent clearing a user's draft.
  try {
    return JSON.stringify(value) as string;
  } catch (error) {
    throwIfAbort(error);
    return null;
  }
}

export function writeBrowserLocalStorage(key: string, value: string): boolean {
  // eslint-disable-next-line no-restricted-syntax -- A failed/quota-exceeded write must prevent the send.
  try {
    localStorage.setItem(key, value);
    return localStorage.getItem(key) === value;
  } catch (error) {
    throwIfAbort(error);
    return false;
  }
}

export function removeBrowserLocalStorage(key: string): void {
  // eslint-disable-next-line no-restricted-syntax -- Revoked storage access must not block canonical event reconciliation.
  try {
    localStorage.removeItem(key);
  } catch (error) {
    throwIfAbort(error);
  }
}

export function listBrowserLocalStorageKeys(prefix: string): string[] | null {
  // eslint-disable-next-line no-restricted-syntax -- Denied enumeration must not be treated as an empty saved intent list.
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys;
  } catch (error) {
    throwIfAbort(error);
    return null;
  }
}

export const resetDeliveryLocalStorageForTest$ = command(() => {
  for (const key of listBrowserLocalStorageKeys("okou_chat-delivery-v1:") ??
    []) {
    removeBrowserLocalStorage(key);
  }
});

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
