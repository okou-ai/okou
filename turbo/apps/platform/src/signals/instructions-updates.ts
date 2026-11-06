import { command, type Command } from "ccstate";
import { setAblyInvalidationLoop$ } from "./realtime.ts";

export const watchInstructionsUpdates$ = command(
  (
    { set },
    args: {
      scope: "user" | "org";
      topic: string;
      reload$: Command<void, []>;
    },
    signal: AbortSignal,
  ) => {
    const refresh = () => {
      if (!document.hidden) {
        set(args.reload$);
      }
    };
    window.addEventListener("focus", refresh, { signal });
    document.addEventListener("visibilitychange", refresh, { signal });
    set(
      setAblyInvalidationLoop$,
      {
        scope: args.scope,
        topic: args.topic,
        invalidations: [args.reload$],
        options: { onSubscribed: refresh },
      },
      signal,
    );
  },
);
