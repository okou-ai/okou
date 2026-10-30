import { boolean, number, object, string } from "zod";

export const TEST_BROWSER_EXTENSION = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  runtimeId: "abcdefghijklmnopabcdefghijklmnop",
  version: "0.3.0",
});

export const TEST_EXTENSION_TARGETS = Object.freeze([
  {
    targetId: "extension-worker",
    type: "service_worker",
    url: `chrome-extension://${TEST_BROWSER_EXTENSION.runtimeId}/background.js`,
  },
  { targetId: "extension-tab", type: "tab", url: "about:blank" },
]);

interface Command {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export function browserExtensionBootstrap(command: Command): unknown {
  if (command.method === "Target.attachToBrowserTarget") {
    return { sessionId: "extension-browser-session" };
  }
  if (
    command.method === "Target.attachToTarget" &&
    command.params.targetId === "extension-worker"
  ) {
    return { sessionId: "extension-worker-session" };
  }
  if (command.method === "Extensions.triggerAction") {
    return command.params.id === TEST_BROWSER_EXTENSION.runtimeId
      ? {}
      : new Error("Extension not installed");
  }
  if (
    command.method === "Target.detachFromTarget" ||
    command.method === "Target.setDiscoverTargets" ||
    (command.sessionId === "extension-worker-session" &&
      (command.method === "Runtime.enable" ||
        command.method === "Runtime.addBinding" ||
        command.method === "Runtime.removeBinding"))
  ) {
    return {};
  }
  return undefined;
}

const requestSchema = object({
  method: string(),
  windowId: number().optional(),
  populate: boolean().optional(),
  url: string().optional(),
});

export function browserExtensionRequest(command: Command) {
  if (
    command.method !== "Runtime.evaluate" ||
    command.sessionId !== "extension-worker-session"
  ) {
    return undefined;
  }
  const expression = string().parse(command.params.expression);
  const prefix = "globalThis.__okouBrowser?.invoke(";
  if (!expression.startsWith(prefix) || !expression.endsWith(")")) {
    throw new Error("Unexpected native bridge request");
  }
  return requestSchema.parse(JSON.parse(expression.slice(prefix.length, -1)));
}

export function browserExtensionReply(
  value: unknown,
  sequence = 0,
  startedSequence = sequence,
) {
  return {
    result: {
      value: {
        ok: true,
        epoch: "fixture-worker",
        startedSequence,
        sequence,
        value,
      },
    },
  };
}
