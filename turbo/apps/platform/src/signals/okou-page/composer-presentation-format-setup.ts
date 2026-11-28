import { command, computed, state, type Command, type Computed } from "ccstate";
import type { PresentationOutputFormat } from "@okouai/core/presentation-output-format";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { rootSignal$ } from "../root-signal.ts";
import { onDomEventFn, onRef } from "../utils.ts";
import type { ComposerPrimaryAction } from "./composer-signals.ts";
import {
  presentationFormatPreference$,
  presentationOutputFormatEnabled$,
} from "./presentation-output-format.ts";
import { updatePresentationFormat$ } from "./settings/presentation-format-preference.ts";
import { openSettingsDialogAt$ } from "./settings/settings-dialog.ts";

interface SetupRequest {
  readonly additionalInfo: string | undefined;
  readonly owner: { readonly signal: AbortSignal };
}

interface SetupOptions {
  readonly knownPresentation$: Computed<boolean>;
  readonly primaryAction$: Computed<Promise<ComposerPrimaryAction>>;
  readonly submitCurrentInput$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, string | undefined, AbortSignal]
  >;
}

const announceSavedDefault$ = command(({ get, set }) => {
  toast(
    i18n.t(($) => {
      return $.chat.composer.presentationFormatSetup.savedDefault;
    }),
    {
      ...TEXT_TOAST_ACTION,
      action: {
        label: i18n.t(($) => {
          return $.chat.composer.presentationFormatSetup.openSettings;
        }),
        onClick: onDomEventFn(async () => {
          await set(openSettingsDialogAt$, "chat", get(rootSignal$));
        }),
      },
    },
  );
});

function createSetupAnchorSignals() {
  const element$ = state<HTMLButtonElement | null>(null);
  const anchor$ = computed((get) => {
    return get(element$);
  });
  const setAnchor$ = onRef(
    command(({ get, set }, element: HTMLButtonElement, signal: AbortSignal) => {
      set(element$, element);
      signal.addEventListener(
        "abort",
        () => {
          if (get(element$) === element) {
            set(element$, null);
          }
        },
        { once: true },
      );
    }),
  );
  const finalFocus$ = command(({ get }) => {
    return get(element$);
  });
  return { anchor$, setAnchor$, finalFocus$ };
}

function createSetupRequestSignals(options: SetupOptions) {
  const request$ = state<SetupRequest | null>(null);
  const owner$ = state<SetupRequest["owner"] | null>(null);
  const operation$ = state<Promise<boolean> | null>(null);
  // Observe the confirmed cache only for a known Presentation task. Normal
  // Send never awaits a preference read or adds that value to its document.
  const required$ = computed(async (get) => {
    if (!get(options.knownPresentation$)) {
      return false;
    }
    return (await get(presentationFormatPreference$)) === null;
  });
  const open$ = computed(async (get) => {
    const requested = get(request$) !== null;
    const knownPresentation = get(options.knownPresentation$);
    return (
      requested &&
      knownPresentation &&
      (await get(presentationOutputFormatEnabled$))
    );
  });
  const confirmation$ = computed((get) => {
    return get(operation$);
  });
  const setup$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const previous = get(owner$);
    const owner = previous?.signal === signal ? previous : { signal };
    if (previous !== owner) {
      set(request$, null);
      set(operation$, null);
    }
    set(owner$, owner);
    signal.addEventListener(
      "abort",
      () => {
        if (get(owner$) === owner) {
          set(owner$, null);
          set(request$, null);
          set(operation$, null);
        }
      },
      { once: true },
    );
  });
  const dismiss$ = command(({ get, set }) => {
    // Choosing has already confirmed the write; dismissal is not a rollback.
    if (!get(operation$)) {
      set(request$, null);
    }
  });
  return {
    request$,
    owner$,
    operation$,
    required$,
    open$,
    confirmation$,
    setup$,
    dismiss$,
  };
}

type SetupSession = ReturnType<typeof createSetupRequestSignals>;

function createSaveAndSubmitCommand(
  options: SetupOptions,
  session: SetupSession,
) {
  const { request$, open$ } = session;
  return command(
    async (
      { get, set },
      request: SetupRequest,
      format: PresentationOutputFormat,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const saveSignal = AbortSignal.any([signal, request.owner.signal]);
      saveSignal.throwIfAborted();
      if (!(await get(open$)) || get(request$) !== request) {
        return false;
      }
      await set(updatePresentationFormat$, format, saveSignal);
      signal.throwIfAborted();
      request.owner.signal.throwIfAborted();
      if (get(request$) !== request) {
        return false;
      }
      set(announceSavedDefault$);
      set(request$, null);
      const action = await get(options.primaryAction$);
      signal.throwIfAborted();
      request.owner.signal.throwIfAborted();
      if (action !== "send" && action !== "queue") {
        return false;
      }
      // Once sending starts, preserve its existing navigation-safe lifetime.
      return await set(
        options.submitCurrentInput$,
        action,
        request.additionalInfo,
        signal,
      );
    },
  );
}

function createSubmitAttemptCommand(
  options: SetupOptions,
  session: SetupSession,
) {
  return command(
    async (
      { get, set },
      action: ComposerPrimaryAction,
      additionalInfo: string | undefined,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (get(session.request$) && (await get(session.open$))) {
        return false;
      }
      set(session.request$, null);
      // Untagged sends do not read preferences. Only the first-use presentation
      // gate observes the already-owned member preference resource.
      if (
        (action === "send" || action === "queue") &&
        get(options.knownPresentation$)
      ) {
        const owner = get(session.owner$);
        const required = await get(session.required$);
        signal.throwIfAborted();
        owner?.signal.throwIfAborted();
        if (get(session.owner$) !== owner || !get(options.knownPresentation$)) {
          return false;
        }
        if (required && owner) {
          set(session.request$, { additionalInfo, owner });
          return false;
        }
      }
      signal.throwIfAborted();
      return await set(
        options.submitCurrentInput$,
        action,
        additionalInfo,
        signal,
      );
    },
  );
}

/** A composer owns one first-use request; its draft stays in the normal editor. */
export function createPresentationFormatSetupSignals(options: SetupOptions) {
  const session = createSetupRequestSignals(options);
  const { operation$, required$, open$ } = session;
  const anchor = createSetupAnchorSignals();
  const saveAndSubmit$ = createSaveAndSubmitCommand(options, session);
  const attemptSubmit$ = createSubmitAttemptCommand(options, session);
  const submit$ = command(
    async (
      { get, set },
      action: ComposerPrimaryAction,
      additionalInfo: string | undefined,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      if (get(operation$)) {
        return false;
      }
      const operation = set(attemptSubmit$, action, additionalInfo, signal);
      set(operation$, operation);
      return await operation.finally(() => {
        if (get(operation$) === operation) {
          set(operation$, null);
        }
      });
    },
  );
  const confirm$ = command(
    async (
      { get, set },
      format: PresentationOutputFormat,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const request = get(session.request$);
      if (!request || get(operation$)) {
        return false;
      }
      const operation = set(saveAndSubmit$, request, format, signal);
      set(operation$, operation);
      return await operation.finally(() => {
        if (get(operation$) === operation) {
          set(operation$, null);
        }
      });
    },
  );
  return {
    ...anchor,
    setup$: session.setup$,
    required$,
    open$,
    confirmation$: session.confirmation$,
    dismiss$: session.dismiss$,
    submit$,
    confirm$,
  };
}

export type PresentationFormatSetupSignals = ReturnType<
  typeof createPresentationFormatSetupSignals
>;
