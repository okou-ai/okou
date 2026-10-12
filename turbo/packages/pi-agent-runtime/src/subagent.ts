import {
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import { createPiAgentSessionForRuntime } from "./session-runtime";

/** Independent child context using the same model, resources and tool wrappers. */
export async function runPiSubagent(
  args: Omit<
    Parameters<typeof createPiAgentSessionForRuntime>[0],
    "sessionManager" | "sessionRole"
  > & {
    readonly sessionId: string;
    readonly prompt: string;
    readonly subscribeInput: (steer: (text: string) => void) => () => void;
    readonly onEvent: Parameters<AgentSession["subscribe"]>[0];
  },
  signal: AbortSignal,
): Promise<void> {
  const created = await createPiAgentSessionForRuntime(
    {
      ...args,
      sessionManager: SessionManager.inMemory(args.cwd, { id: args.sessionId }),
      sessionRole: "child",
    },
    signal,
  );
  const { session } = created;
  const unsubscribe = session.subscribe(args.onEvent);
  const unsubscribeInput = args.subscribeInput((text) => {
    void session.steer(text).catch(() => {
      // A fire-and-forget instruction can race settlement or cancellation.
    });
  });
  const abort = () => {
    void session.abort().catch(() => {
      // The prompt owns the failure result; cancellation is best effort here.
    });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await session.prompt(args.prompt);
  } finally {
    signal.removeEventListener("abort", abort);
    unsubscribeInput();
    try {
      await session.abort();
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
}
