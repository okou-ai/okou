import { command } from "ccstate";
import { encryptStoredSecretValue } from "./crypto.utils";
import type { InternalRunCallbackKind } from "./internal-run-callback";

export interface CallbackOwner {
  readonly orgId: string;
  readonly userId: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface HttpExecutionCallback {
  readonly kind: "http";
  readonly url: string;
  readonly secret: string;
  readonly payload: JsonValue;
}

export interface InternalExecutionCallback {
  readonly kind: "internal";
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: JsonValue;
}

export type ExecutionCallback =
  | HttpExecutionCallback
  | InternalExecutionCallback;

export interface PreparedHttpCallback {
  readonly kind: "http";
  readonly url: string;
  readonly encryptedSecret: string;
  readonly payload: JsonValue;
}

export interface PreparedInternalCallback {
  readonly kind: "internal";
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: JsonValue;
}

export type PreparedCallback = PreparedHttpCallback | PreparedInternalCallback;

/** Encrypt definitions before commit without selecting, persisting or delivering them. */
export const prepareCallbacks$ = command(
  async (
    _context,
    _owner: CallbackOwner,
    callbacks: readonly ExecutionCallback[],
    signal: AbortSignal,
  ): Promise<readonly PreparedCallback[]> => {
    signal.throwIfAborted();
    return await Promise.all(
      callbacks.map(async (callback): Promise<PreparedCallback> => {
        if (callback.kind === "internal") {
          return callback;
        }
        const encryptedSecret = await encryptStoredSecretValue(callback.secret);
        signal.throwIfAborted();
        return {
          kind: "http",
          url: callback.url,
          encryptedSecret,
          payload: callback.payload,
        };
      }),
    );
  },
);
