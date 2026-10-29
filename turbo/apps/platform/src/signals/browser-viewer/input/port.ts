import type { InputSession } from "./session.ts";

/** Raw session capabilities used only to create original-owner input bindings. */
export type NativeInputPort = Pick<
  InputSession,
  | "owner"
  | "focus"
  | "blur"
  | "pointer"
  | "key"
  | "text"
  | "preedit"
  | "commitComposition"
  | "selection"
  | "clipboardError"
>;
