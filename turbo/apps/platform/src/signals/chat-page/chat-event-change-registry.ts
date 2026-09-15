import { command, state, type Command, type Computed } from "ccstate";
import type { ChatEvent } from "./chat-event-types.ts";

type ChatEventsSignal = Computed<ChatEvent[]>;

export interface ChatEventChangeHandler {
  readonly command$: Command<
    Promise<void>,
    [ChatEventChangeHandler, AbortSignal]
  >;
}

interface ChatEventChangeRegistration {
  readonly id: string;
  readonly handler: ChatEventChangeHandler;
}

const registrationsByEvents$ = state(
  new Map<ChatEventsSignal, readonly ChatEventChangeRegistration[]>(),
);
const ownerSignalsByRegistrationId$ = state(new Map<string, AbortSignal>());

const unregisterChatEventChangeHandler$ = command(
  ({ get, set }, events$: ChatEventsSignal, id: string): void => {
    const ownerSignals = new Map(get(ownerSignalsByRegistrationId$));
    ownerSignals.delete(id);
    set(ownerSignalsByRegistrationId$, ownerSignals);
    const current = get(registrationsByEvents$);
    const registrations = current.get(events$);
    if (registrations === undefined) {
      return;
    }
    const remaining = registrations.filter((registration) => {
      return registration.id !== id;
    });
    const next = new Map(current);
    if (remaining.length === 0) {
      next.delete(events$);
    } else {
      next.set(events$, remaining);
    }
    set(registrationsByEvents$, next);
  },
);

const invokeChatEventChangeHandler$ = command(
  async (
    { set },
    handler: ChatEventChangeHandler,
    signal: AbortSignal,
  ): Promise<void> => {
    const [completion] = await Promise.allSettled([
      set(handler.command$, handler, signal),
    ]);
    if (signal.aborted) {
      return;
    }
    if (completion.status === "rejected") {
      throw completion.reason;
    }
  },
);

export const registerChatEventChangeHandler$ = command(
  (
    { get, set },
    events$: ChatEventsSignal,
    handler: ChatEventChangeHandler,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const current = get(registrationsByEvents$);
    const next = new Map(current);
    next.set(events$, [...(current.get(events$) ?? []), { id, handler }]);
    set(registrationsByEvents$, next);
    const ownerSignals = new Map(get(ownerSignalsByRegistrationId$));
    ownerSignals.set(id, signal);
    set(ownerSignalsByRegistrationId$, ownerSignals);
    signal.addEventListener(
      "abort",
      () => {
        set(unregisterChatEventChangeHandler$, events$, id);
      },
      { once: true },
    );
  },
);

export const notifyChatEventsChanged$ = command(
  async (
    { get, set },
    events$: ChatEventsSignal,
    signal: AbortSignal,
  ): Promise<void> => {
    const ownerSignals = get(ownerSignalsByRegistrationId$);
    await Promise.all(
      (get(registrationsByEvents$).get(events$) ?? []).flatMap(
        (registration) => {
          const ownerSignal = ownerSignals.get(registration.id);
          return ownerSignal === undefined
            ? []
            : [
                set(
                  invokeChatEventChangeHandler$,
                  registration.handler,
                  AbortSignal.any([ownerSignal, signal]),
                ),
              ];
        },
      ),
    );
    signal.throwIfAborted();
  },
);
