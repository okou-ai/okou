import { command, computed, state, type State } from "ccstate";

type StorageAccessor = () => Storage;

export function createResetStorageForTest(
  storage: StorageAccessor,
  registeredKeys$: State<Set<string> | null>,
) {
  return command(({ set, get }) => {
    const keys = get(registeredKeys$);
    for (const key of keys ?? []) {
      storage().removeItem(key);
    }

    set(registeredKeys$, null);
  });
}

export function createStorageSignals(
  storage: StorageAccessor,
  registeredKeys$: State<Set<string> | null>,
  key: string,
) {
  const reload$ = state(0);

  const get$ = computed((get) => {
    get(reload$);
    return storage().getItem(key);
  });

  const set$ = command(({ set }, value: string) => {
    set(registeredKeys$, (registeredKeys) => {
      if (registeredKeys?.has(key)) {
        return registeredKeys;
      }

      const nextRegisteredKeys = new Set(registeredKeys ?? []);
      nextRegisteredKeys.add(key);
      return nextRegisteredKeys;
    });
    storage().setItem(key, value);
    set(reload$, (previous) => {
      return previous + 1;
    });
  });

  const clear$ = command(({ set }) => {
    storage().removeItem(key);
    set(reload$, (previous) => {
      return previous + 1;
    });
  });

  return Object.freeze({ get$, set$, clear$ });
}
