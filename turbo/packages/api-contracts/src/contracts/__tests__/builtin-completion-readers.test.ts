import { describe, expect, it } from "vitest";

import {
  builtinConnectorExternalCodeSessionReaderContract,
  builtinConnectorManualGrantReaderContract,
  builtinConnectorNoAuthGrantReaderContract,
  builtinConnectorOauthDeviceAuthSessionReaderContract,
} from "../connector-operation-readers";

const connectionId = "11111111-1111-4111-8111-111111111111";
const siblingId = "22222222-2222-4222-8222-222222222222";

describe.each([
  {
    name: "manual grant",
    schema: builtinConnectorManualGrantReaderContract.connect.responses[200],
    status: {},
    legacy: (id: unknown) => {
      return { id };
    },
  },
  {
    name: "no-auth grant",
    schema: builtinConnectorNoAuthGrantReaderContract.connect.responses[200],
    status: {},
    legacy: (id: unknown) => {
      return { id };
    },
  },
  {
    name: "device authorization",
    schema:
      builtinConnectorOauthDeviceAuthSessionReaderContract.poll.responses[200],
    status: { status: "complete" },
    legacy: (id: unknown) => {
      return { connector: { id } };
    },
  },
  {
    name: "external code",
    schema:
      builtinConnectorExternalCodeSessionReaderContract.complete.responses[200],
    status: { status: "complete" },
    legacy: (id: unknown) => {
      return { connector: { id } };
    },
  },
])("$name completion identity boundary", ({ schema, status, legacy }) => {
  it.each(["canonical", "legacy", "matching"])(
    "reads the exact operated account from a %s receipt",
    (shape) => {
      const parsed = schema.parse({
        ...status,
        ...(shape !== "legacy" ? { connectionId } : {}),
        ...(shape !== "canonical" ? legacy(connectionId) : {}),
        accessToken: "must-not-reach-the-reader",
      });
      expect(parsed).toMatchObject({ connectionId });
      expect(parsed).not.toHaveProperty("accessToken");
    },
  );

  it.each([
    "missing",
    "unrelated alias",
    "conflicting",
    "malformed canonical",
    "malformed legacy",
  ])("rejects %s operation identity", (shape) => {
    const payload = {
      ...status,
      ...(shape === "unrelated alias"
        ? { connectedAccountId: connectionId }
        : {}),
      ...(shape === "conflicting"
        ? { connectionId, ...legacy(siblingId) }
        : {}),
      ...(shape === "malformed canonical"
        ? { connectionId: "invalid", ...legacy(connectionId) }
        : {}),
      ...(shape === "malformed legacy"
        ? { connectionId, ...legacy("invalid") }
        : {}),
    };
    expect(schema.safeParse(payload).success).toBe(false);
  });
});

it.each([
  { status: "pending", interval: 5 },
  { status: "denied", errorMessage: "Declined by the account owner" },
  { status: "expired", errorCode: "expired_token" },
  { status: "error", errorMessage: "Authorization provider unavailable" },
])("retains device poll progress and terminal response $status", (response) => {
  expect(
    builtinConnectorOauthDeviceAuthSessionReaderContract.poll.responses[200].parse(
      response,
    ),
  ).toStrictEqual(response);
});
