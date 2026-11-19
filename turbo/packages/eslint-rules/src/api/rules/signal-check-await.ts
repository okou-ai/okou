import { createSignalCheckAwaitRule } from "../../signal-check-await.ts";

export const signalCheckAwait = createSignalCheckAwaitRule({
  allowOptionalChain: true,
});
