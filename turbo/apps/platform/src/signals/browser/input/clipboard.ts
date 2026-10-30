import { command, computed, state, type Computed } from "ccstate";
import {
  callAsync,
  createDeferredPromise,
  detach,
  Reason,
  type DeferredPromise,
} from "../../utils.ts";
import { clipboardTextLimit } from "./selection.ts";
import type { InputBinding, InputIngress } from "./ingress.ts";
import type { NativeInputPort } from "./port.ts";

export interface ClipboardRecovery {
  readonly message: string;
  readonly text: string | null;
}
const recoveryMessage =
  "Automatic copy is unavailable. Select the text below and use your browser's Copy command, or try Copy text.";
const unavailableMessage =
  "Copy is unavailable for this selection. Use selected page text or a supported text control.";
interface ClipboardOrigin {
  readonly input: NativeInputPort;
  readonly epoch: number;
  readonly transition: { readonly id: number } | null;
}
interface CopyAttempt extends ClipboardOrigin {
  readonly data: DeferredPromise<Blob>;
  readonly binding: InputBinding;
  readonly text: string | null;
  readonly failed: boolean;
}

/** Clipboard snapshots and their original input identity are private atoms. */
function createClipboardObservation(
  proxy$: Computed<HTMLTextAreaElement | null>,
  input$: Computed<NativeInputPort | null>,
  ingress: InputIngress,
) {
  const attempt$ = state<CopyAttempt | null>(null);
  const internalRecovery$ = state<
    (ClipboardOrigin & { readonly value: ClipboardRecovery }) | null
  >(null);
  // This projection invalidates recovery eagerly when remote input changes,
  // without a Store subscription or a callback back into the session graph.
  const recovery$ = computed((get): ClipboardRecovery | null => {
    const recovery = get(internalRecovery$);
    const input = get(input$);
    if (!recovery || input !== recovery.input || !get(input.available$)) {
      return null;
    }
    const epoch = get(input.clipboardEpoch$);
    const transition = get(input.transition$);
    // A focus handoff invalidates an unfinished read, not recovered plain text.
    const blurred =
      epoch === recovery.epoch + 1 &&
      transition?.reason === "blur" &&
      transition.id === (recovery.transition?.id ?? 0) + 1;
    return epoch === recovery.epoch || blurred ? recovery.value : null;
  });
  const reset$ = command(({ get, set }, keepRecovery = false) => {
    const attempt = get(attempt$);
    set(attempt$, null);
    if (attempt && !attempt.data.settled()) {
      attempt.data.reject(new Error("Copy cancelled"));
    }
    const recovery = get(internalRecovery$);
    if (keepRecovery && recovery && get(recovery$)) {
      set(internalRecovery$, {
        ...recovery,
        epoch: get(recovery.input.clipboardEpoch$),
        transition: get(recovery.input.transition$),
      });
    } else {
      set(internalRecovery$, null);
    }
  });
  const synchronize$ = command(({ get, set }) => {
    const input = get(input$);
    const attempt = get(attempt$);
    if (
      attempt &&
      (input !== attempt.input ||
        !get(attempt.binding.owner$) ||
        get(attempt.input.clipboardEpoch$) !== attempt.epoch)
    ) {
      set(attempt$, null);
      if (!attempt.data.settled()) {
        attempt.data.reject(new Error("Copy cancelled"));
      }
    }
    // Retire the actual private text, not merely its public projection. A later
    // authority/epoch change must never resurrect a previously invalid recovery.
    const recovery = get(internalRecovery$);
    if (recovery && !get(recovery$)) {
      set(internalRecovery$, null);
    }
  });
  const focused$ = command(
    ({ get, set }, event?: Event): InputBinding | null => {
      const proxy = get(proxy$);
      return proxy && document.activeElement === proxy
        ? event
          ? set(ingress.boundary$, event)
          : set(ingress.current$)
        : null;
    },
  );
  const currentAttempt$ = command(
    ({ get, set }, data: DeferredPromise<Blob>): CopyAttempt | null => {
      const attempt = get(attempt$);
      const input = get(input$);
      return attempt?.data === data &&
        input === attempt.input &&
        get(input.clipboardEpoch$) === attempt.epoch &&
        set(focused$) === attempt.binding &&
        get(attempt.binding.owner$)
        ? attempt
        : null;
    },
  );
  const failed$ = command(({ set }, data: DeferredPromise<Blob>) => {
    const attempt = set(currentAttempt$, data);
    if (!attempt) {
      return;
    }
    set(attempt$, { ...attempt, failed: true });
    if (attempt.text !== null) {
      set(internalRecovery$, {
        input: attempt.input,
        epoch: attempt.epoch,
        transition: attempt.transition,
        value: { message: recoveryMessage, text: attempt.text },
      });
      set(
        attempt.binding.clipboardError$,
        "Local clipboard access failed. Use the copy recovery controls.",
      );
    }
  });
  return {
    attempt$,
    internalRecovery$,
    recovery$,
    reset$,
    synchronize$,
    focused$,
    currentAttempt$,
    failed$,
  };
}
type ClipboardObservation = ReturnType<typeof createClipboardObservation>;

/** Trusted activation starts local writing before the ordered remote read. */
function createClipboardTransfer(observation: ClipboardObservation) {
  const { attempt$, internalRecovery$, currentAttempt$, failed$ } = observation;
  const writeData$ = command(
    async (
      { get, set },
      data: DeferredPromise<Blob>,
      signal: AbortSignal,
    ): Promise<void> => {
      // callAsync invokes write synchronously, before this command first yields.
      const [result] = await Promise.allSettled([
        callAsync(() => {
          return navigator.clipboard.write([
            new ClipboardItem({ "text/plain": data.promise }),
          ]);
        }),
      ]);
      if (signal.aborted) {
        return;
      }
      if (result.status === "fulfilled") {
        if (get(attempt$)?.data === data) {
          set(attempt$, null);
          set(internalRecovery$, null);
        }
      } else {
        set(failed$, data);
      }
    },
  );
  const readSelection$ = command(
    async (
      { get, set },
      binding: InputBinding,
      data: DeferredPromise<Blob>,
      signal: AbortSignal,
    ): Promise<void> => {
      const owner = get(binding.owner$);
      if (!owner) {
        if (!data.settled()) {
          data.reject(new Error("Copy cancelled"));
        }
        return;
      }
      const selection = set(binding.selection$, owner, signal);
      // The session increments its clipboard epoch synchronously when admitting
      // this read. Retain that epoch, not the pre-admission copy gesture epoch.
      const admitted = get(attempt$);
      if (admitted?.data === data) {
        set(attempt$, {
          ...admitted,
          epoch: get(binding.target.clipboardEpoch$),
          transition: get(binding.target.transition$),
        });
      }
      const [reply] = await Promise.allSettled([selection]);
      if (signal.aborted) {
        return;
      }
      const attempt = set(currentAttempt$, data);
      if (!attempt) {
        if (!data.settled()) {
          data.reject(new Error("Copy cancelled"));
        }
        return;
      }
      if (reply.status === "rejected") {
        if (!data.settled()) {
          data.reject(new Error("Selection unavailable"));
        }
        set(attempt$, null);
        set(
          binding.clipboardError$,
          "Copy could not be completed. Select the text and try again.",
        );
        return;
      }
      const result = reply.value;
      if (result.status !== "ok" || !result.text) {
        set(attempt$, null);
        if (!data.settled()) {
          data.reject(new Error("No supported selection"));
        }
        if (result.status !== "empty") {
          const message =
            result.status === "too-large"
              ? "Selected text exceeds the supported clipboard size."
              : result.status === "stale"
                ? "The selection changed while copying. Select the text again."
                : unavailableMessage;
          set(binding.clipboardError$, message);
          set(internalRecovery$, {
            input: attempt.input,
            epoch: attempt.epoch,
            transition: attempt.transition,
            value: { message, text: null },
          });
        }
        return;
      }
      set(attempt$, { ...attempt, text: result.text });
      if (!data.settled()) {
        data.resolve(new Blob([result.text], { type: "text/plain" }));
      }
      if (attempt.failed) {
        set(failed$, data);
      }
    },
  );
  return { writeData$, readSelection$ };
}

function createClipboardActions(
  observation: ClipboardObservation,
  transfer: ReturnType<typeof createClipboardTransfer>,
  ingress: InputIngress,
  composing$: Computed<boolean>,
) {
  const { attempt$, recovery$, reset$, focused$ } = observation;
  const { writeData$, readSelection$ } = transfer;
  const paste$ = command(({ get, set }, event: ClipboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const input = set(focused$, event);
    const owner = input ? get(input.owner$) : null;
    if (!event.isTrusted || !input || !owner) {
      return;
    }
    if (get(composing$)) {
      set(input.clipboardError$, "Finish composing text before pasting.");
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length > clipboardTextLimit) {
      set(input.clipboardError$, "Clipboard text exceeds the supported size.");
      return;
    }
    if (
      !text &&
      event.clipboardData?.types.length &&
      !event.clipboardData.types.includes("text/plain")
    ) {
      set(
        input.clipboardError$,
        "Only plain-text clipboard transfer is supported.",
      );
      return;
    }
    if (text) {
      set(input.text$, text, owner);
    }
  });
  const copy$ = command(
    ({ get, set }, event: ClipboardEvent, signal: AbortSignal) => {
      event.preventDefault();
      event.stopPropagation();
      const binding = set(focused$, event);
      const owner = binding ? get(binding.owner$) : null;
      if (!event.isTrusted || !binding || !owner || signal.aborted) {
        return;
      }
      set(reset$);
      if (get(composing$)) {
        set(binding.clipboardError$, "Finish composing text before copying.");
        return;
      }
      const data = createDeferredPromise<Blob>(signal);
      set(attempt$, {
        data,
        binding,
        input: binding.target,
        epoch: get(binding.target.clipboardEpoch$),
        transition: get(binding.target.transition$),
        text: null,
        failed: false,
      });
      // Both operations start inside the trusted browser event. The remote read
      // never delays invocation of the local clipboard permission boundary.
      detach(set(writeData$, data, signal), Reason.DomCallback, "browser copy");
      detach(
        set(readSelection$, binding, data, signal),
        Reason.DomCallback,
        "browser selection",
      );
    },
  );
  const copyRecovery$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const recovery = get(recovery$);
      if (!recovery || recovery.text === null) {
        return;
      }
      const [result] = await Promise.allSettled([
        callAsync(() => {
          return navigator.clipboard.writeText(recovery.text!);
        }),
      ]);
      signal.throwIfAborted();
      if (get(recovery$) !== recovery) {
        return;
      }
      if (result.status === "fulfilled") {
        set(reset$);
      } else {
        const input = set(ingress.current$);
        if (input) {
          set(
            input.clipboardError$,
            "Use your browser's Copy command on the selected recovery text.",
          );
        }
      }
    },
  );
  const bind$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(reset$);
    signal.addEventListener(
      "abort",
      () => {
        set(reset$);
      },
      { once: true },
    );
  });
  const dismiss$ = command(({ set }) => {
    set(reset$);
  });
  return { bind$, copy$, paste$, copyRecovery$, dismiss$ };
}

/** Local clipboard effects retain the original gesture, selection and owner. */
export function createNativeClipboard(
  proxy$: Computed<HTMLTextAreaElement | null>,
  input$: Computed<NativeInputPort | null>,
  ingress: InputIngress,
  composing$: Computed<boolean>,
) {
  const observation = createClipboardObservation(proxy$, input$, ingress);
  const transfer = createClipboardTransfer(observation);
  const actions = createClipboardActions(
    observation,
    transfer,
    ingress,
    composing$,
  );
  return {
    ...actions,
    reset$: observation.reset$,
    synchronize$: observation.synchronize$,
    recovery$: observation.recovery$,
  };
}
