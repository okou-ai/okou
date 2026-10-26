import { runnerBrowserContract } from "../contracts/runner-browser";
import type { RustTypeBinding, RustTypeDeclarationDoc } from "./types";

function doc(
  rustTypeName: string,
  fields: readonly string[] = [],
  variants: readonly string[] = [],
): RustTypeDeclarationDoc {
  return {
    rustTypeName,
    rustDoc: [
      "Existing Browser contract; identities and deadlines are API-owned.",
    ],
    fields: Object.fromEntries(
      fields.map((key) => {
        return [key, [`Existing ${key} field.`]];
      }),
    ),
    variants: Object.fromEntries(
      variants.map((key) => {
        return [key, [`Existing ${key} outcome.`]];
      }),
    ),
  };
}

const identity = ["runnerId", "heartbeatGeneration"];
const windowFields = ["chatThreadId", "state", "expiresAt", "primaryWindowId"];
const instanceFields = [
  "id",
  "ownerProfileId",
  "providerProfileId",
  "providerSessionId",
  "status",
  "creationExpiresAt",
  "timeoutAt",
  "window",
];

export const browserTypeBindings = [
  {
    schema: runnerBrowserContract.control.body,
    rustModulePath: ["runners", "browser"],
    rustTypeName: "ControlRequest",
    direction: "request",
    declarations: [
      doc("ControlRequest", ["runnerIdentity", "action"]),
      doc("ControlRequestRunnerIdentity", identity),
      doc(
        "ControlRequestAction",
        [
          "instanceId",
          "providerSessionId",
          "primaryWindowId",
          "timeoutAt",
          "reason",
        ],
        [
          "inspect",
          "authorize",
          "allocate",
          "publish",
          "admit",
          "renew",
          "retire",
          "completeWindowClose",
          "beginStop",
          "completeStop",
        ],
      ),
      doc("ControlRequestActionRetireReason", [], ["expired", "closed"]),
    ],
  },
  {
    schema: runnerBrowserContract.control.responses[200],
    rustModulePath: ["runners", "browser"],
    rustTypeName: "ControlResponse",
    direction: "response",
    declarations: [
      doc("ControlResponse", ["instance"], ["accepted", "unavailable"]),
      doc("ControlResponseAcceptedInstance", instanceFields),
      doc(
        "ControlResponseAcceptedInstanceStatus",
        [],
        ["creating", "active", "stopping", "stopped"],
      ),
      doc("ControlResponseAcceptedInstanceWindow", windowFields),
      doc(
        "ControlResponseAcceptedInstanceWindowState",
        [],
        ["active", "closing"],
      ),
    ],
  },
  {
    schema: runnerBrowserContract.connection.body,
    rustModulePath: ["runners", "browser"],
    rustTypeName: "ConnectionRequest",
    direction: "request",
    declarations: [
      doc("ConnectionRequest", [
        "runnerIdentity",
        "instanceId",
        "providerSessionId",
        "primaryWindowId",
      ]),
      doc("ConnectionRequestRunnerIdentity", identity),
    ],
  },
  {
    schema: runnerBrowserContract.connection.responses[200],
    rustModulePath: ["runners", "browser"],
    rustTypeName: "ConnectionResponse",
    direction: "response",
    sensitive: true,
    declarations: [
      doc("ConnectionResponse", ["connection"], ["accepted", "unavailable"]),
      doc("ConnectionResponseAcceptedConnection", [
        "instanceId",
        "providerSessionId",
        "primaryWindowId",
        "chatThreadId",
        "cdpUrl",
        "expiresAt",
      ]),
    ],
  },
] as const satisfies readonly RustTypeBinding[];
