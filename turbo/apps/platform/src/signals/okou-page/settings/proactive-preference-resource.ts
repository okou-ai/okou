import { command, computed, state, type Computed } from "ccstate";
import { apiClient$, type ApiClientFactory } from "../../api-client.ts";
import { authenticatedSessionKey$ } from "../../auth.ts";
import { searchParams$ } from "../../route.ts";

interface PreferenceScope {
  readonly client: ApiClientFactory;
  readonly session: string | null;
  readonly readiness: Promise<unknown>;
}

type Confirmation<Value> =
  | {
      readonly kind: "saved";
      readonly scope: PreferenceScope;
      readonly value: Value;
    }
  | { readonly kind: "reload" };

export function createProactivePreference<Value, Readiness>(
  readiness$: Computed<Promise<Readiness>>,
  read: (client: ApiClientFactory, readiness: Readiness) => Promise<Value>,
  write: (
    client: ApiClientFactory,
    enabled: boolean,
    signal: AbortSignal,
  ) => Promise<{ readonly saved: boolean; readonly value: Value }>,
) {
  const scope$ = computed((get) => {
    get(searchParams$);
    return {
      client: get(apiClient$),
      session: get(authenticatedSessionKey$),
      readiness: get(readiness$),
    };
  });
  const confirmation$ = state<Confirmation<Value> | null>(null);
  const writes$ = state({ active: 0, sequence: 0 });

  const preference$ = computed(async (get) => {
    const scope = get(scope$);
    const confirmation = get(confirmation$);
    if (confirmation?.kind === "saved" && confirmation.scope === scope) {
      return confirmation.value;
    }
    return await read(scope.client, await scope.readiness);
  });

  const update$ = command(
    async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
      signal.throwIfAborted();
      const scope = get(scope$);
      const { active, sequence } = get(writes$);
      set(writes$, { active: active + 1, sequence: sequence + 1 });
      const saving = (async () => {
        const result = await write(scope.client, enabled, signal);
        signal.throwIfAborted();
        const current = get(scope$);
        if (
          result.saved &&
          current.client === scope.client &&
          current.session === scope.session
        ) {
          // Concurrent writes may commit in a different order from their responses.
          const ordered =
            active === 0 && get(writes$).sequence === sequence + 1;
          set(
            confirmation$,
            current === scope && ordered
              ? { kind: "saved", scope, value: result.value }
              : { kind: "reload" },
          );
          await get(preference$);
          signal.throwIfAborted();
        }
        return result.value;
      })();
      return await saving.finally(() => {
        set(writes$, (current) => {
          return { ...current, active: current.active - 1 };
        });
      });
    },
  );

  return { preference$, update$ };
}
