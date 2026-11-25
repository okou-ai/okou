import { command, computed, state, type Command, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { PresentationOutputFormat } from "@okouai/core/presentation-output-format";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { rootSignal$ } from "../root-signal.ts";
import { onDomEventFn, onRef } from "../utils.ts";
import type { ComposerPrimaryAction } from "./composer-signals.ts";
import type { ComposerTask } from "./composer-task-chips.ts";
import { presentationOutputFormat$ } from "./presentation-output-format.ts";
import { updatePresentationFormat$ } from "./settings/presentation-format-preference.ts";
import { openSettingsDialogAt$ } from "./settings/settings-dialog.ts";

interface PresentationFormatSetupRequest {
  readonly action: ComposerPrimaryAction;
  readonly additionalInfo: string | undefined;
}

interface PresentationFormatSetupOptions {
  readonly task$: Computed<ComposerTask | null>;
  readonly primaryAction$: Computed<Promise<ComposerPrimaryAction>>;
  readonly submitCurrentInput$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, string | undefined, AbortSignal]
  >;
}

function savedDefaultMessage(format: PresentationOutputFormat): string {
  return i18n.t(
    ($) => {
      return $.chat.composer.presentationFormatSetup.savedDefault;
    },
    {
      format: i18n.t(($) => {
        return format === "html"
          ? $.chat.composer.presentationFormatSetup.htmlLabel
          : $.chat.composer.presentationFormatSetup.pptxLabel;
      }),
    },
  );
}

/** The first-use menu opens from the Send button that asked for it. */
function createSetupAnchorSignals() {
  const internalAnchor$ = state<HTMLElement | null>(null);
  const anchor$ = computed((get) => {
    return get(internalAnchor$);
  });
  const setAnchor$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(internalAnchor$, element);
      signal.addEventListener("abort", () => {
        set(internalAnchor$, null);
      });
    }),
  );
  return { anchor$, setAnchor$ };
}

/** The menu is shown once; the toast says where the default now lives. */
const announceSavedDefault$ = command(
  ({ get, set }, format: PresentationOutputFormat) => {
    toast(savedDefaultMessage(format), {
      ...TEXT_TOAST_ACTION,
      action: {
        label: i18n.t(($) => {
          return $.chat.composer.presentationFormatSetup.openSettings;
        }),
        onClick: onDomEventFn(async () => {
          await set(openSettingsDialogAt$, "chat", get(rootSignal$));
        }),
      },
    });
  },
);

export function createPresentationFormatSetupSignals({
  task$,
  primaryAction$,
  submitCurrentInput$,
}: PresentationFormatSetupOptions) {
  // The composer keeps the draft; only its original send action waits here.
  const request$ = state<PresentationFormatSetupRequest | null>(null);
  const selected$ = state<PresentationOutputFormat | null>(null);
  const operation$ = state<Promise<boolean> | null>(null);
  const { anchor$, setAnchor$ } = createSetupAnchorSignals();
  const confirmation$ = computed((get) => {
    return get(operation$);
  });
  const open$ = computed(async (get) => {
    return (
      get(request$) !== null &&
      get(task$) === "presentation" &&
      (await get(featureSwitches$))[
        FeatureSwitchKey.PresentationOutputFormat
      ] === true
    );
  });
  const select$ = command(({ get, set }, format: PresentationOutputFormat) => {
    if (!get(operation$)) {
      set(selected$, format);
    }
  });
  const dismiss$ = command(({ get, set }) => {
    if (!get(operation$)) {
      set(request$, null);
      set(selected$, null);
    }
  });
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
      if (action !== "send" && action !== "queue") {
        return await set(submitCurrentInput$, action, additionalInfo, signal);
      }
      const format =
        get(task$) === "presentation"
          ? await get(presentationOutputFormat$)
          : undefined;
      signal.throwIfAborted();
      if (format === null && get(task$) === "presentation") {
        if (get(request$) !== null) {
          return false;
        }
        const availableAction = await get(primaryAction$);
        signal.throwIfAborted();
        if (
          availableAction !== "disabled" &&
          availableAction !== "stop" &&
          get(task$) === "presentation"
        ) {
          set(selected$, null);
          set(request$, { action, additionalInfo });
          return false;
        }
      }
      set(dismiss$);
      return await set(submitCurrentInput$, action, additionalInfo, signal);
    },
  );
  const saveAndSubmit$ = command(
    async (
      { get, set },
      request: PresentationFormatSetupRequest,
      selected: PresentationOutputFormat,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const current = await get(presentationOutputFormat$);
      signal.throwIfAborted();
      if (current === undefined) {
        set(request$, null);
        return false;
      }
      if (current === null) {
        await set(updatePresentationFormat$, selected, signal);
        signal.throwIfAborted();
        set(announceSavedDefault$, selected);
      }
      set(request$, null);
      set(selected$, null);
      // Keep normal submission identity and error/retry behavior. A saved
      // preference is not an accepted send and never triggers a second send.
      return await set(
        submitCurrentInput$,
        request.action,
        request.additionalInfo,
        signal,
      );
    },
  );
  const confirm$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      signal.throwIfAborted();
      const request = get(request$);
      const selected = get(selected$);
      if (!request || !selected || get(operation$)) {
        return false;
      }
      // Retain the real operation for both single-flight admission and UI.
      const operation = set(saveAndSubmit$, request, selected, signal);
      set(operation$, operation);
      return await operation.finally(() => {
        set(operation$, null);
      });
    },
  );
  return {
    open$,
    anchor$,
    setAnchor$,
    selected$,
    confirmation$,
    select$,
    dismiss$,
    submit$,
    confirm$,
  };
}

export type PresentationFormatSetupSignals = ReturnType<
  typeof createPresentationFormatSetupSignals
>;
