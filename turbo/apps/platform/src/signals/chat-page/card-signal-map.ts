import { command, state, type Command } from "ccstate";

/**
 * A thread-owned registry giving every card a stable signal identity across
 * transcript recomputations. The map is a `state` written only by `register$`,
 * so creating signals is always a command and never a side effect of reading
 * the graph. The map itself stays internal: the command that recognizes a card
 * hands the returned signals to whatever renders them.
 */
export interface CardSignalsRegistry<Descriptor, Signals> {
  /** Get-or-create by the descriptor's key; idempotent per key. */
  readonly register$: Command<Signals, [Descriptor]>;
  /** Start each prepared card's subscription once per owning lifetime. */
  readonly subscribe$: Command<void, [AbortSignal]>;
}

export function createCardSignalsRegistry<Descriptor, Signals>(
  keyOf: (descriptor: Descriptor) => string,
  create: (descriptor: Descriptor) => Signals,
  subscription?: (signals: Signals) => Command<void, [AbortSignal]>,
): CardSignalsRegistry<Descriptor, Signals> {
  const internalSignalsByKey$ = state<ReadonlyMap<string, Signals>>(new Map());

  const register$ = command(({ get, set }, descriptor: Descriptor): Signals => {
    const current = get(internalSignalsByKey$);
    const key = keyOf(descriptor);
    const existing = current.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const signals = create(descriptor);
    const next = new Map(current);
    next.set(key, signals);
    set(internalSignalsByKey$, next);
    return signals;
  });

  const internalSubscribedKeys$ = state<ReadonlySet<string>>(new Set());
  const subscribe$ = command(({ get, set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (!subscription) {
      return;
    }
    for (const [key, signals] of get(internalSignalsByKey$)) {
      if (get(internalSubscribedKeys$).has(key)) {
        continue;
      }
      set(internalSubscribedKeys$, (current) => {
        return new Set([...current, key]);
      });
      signal.addEventListener(
        "abort",
        () => {
          set(internalSubscribedKeys$, (current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        },
        { once: true },
      );
      set(subscription(signals), signal);
    }
  });

  return { register$, subscribe$ };
}
