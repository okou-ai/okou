import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  parseBuiltinConnectorExternalCodeProviderState,
  parseBuiltinConnectorOauthDeviceProviderState,
  serializeBuiltinConnectorExternalCodeProviderState,
  serializeBuiltinConnectorOauthDeviceProviderState,
} from "../connector-authorization-provider-state";

const connectorSlug = "slack";
const authMethod = "oauth";

describe("connector OAuth device provider state", () => {
  it("parses canonical state and preserves poll state", () => {
    expect(
      parseBuiltinConnectorOauthDeviceProviderState({
        serializedState: JSON.stringify({
          connectorSlug,
          deviceCode: "device-code",
          pollState: "poll-state",
          unrelatedProperty: "ignored",
        }),
        connectorSlug,
      }),
    ).toStrictEqual({
      connectorSlug,
      deviceCode: "device-code",
      pollState: "poll-state",
    });
  });

  it("preserves an absent poll state", () => {
    expect(
      parseBuiltinConnectorOauthDeviceProviderState({
        serializedState: JSON.stringify({
          connectorSlug,
          deviceCode: "device-code",
        }),
        connectorSlug,
      }),
    ).toStrictEqual({
      connectorSlug,
      deviceCode: "device-code",
      pollState: undefined,
    });
  });

  it("rejects state without a connector slug", () => {
    expect(() => {
      parseBuiltinConnectorOauthDeviceProviderState({
        serializedState: JSON.stringify({ deviceCode: "device-code" }),
        connectorSlug,
      });
    }).toThrow(ZodError);
  });

  it("rejects a connector mismatch", () => {
    expect(() => {
      parseBuiltinConnectorOauthDeviceProviderState({
        serializedState: JSON.stringify({
          connectorSlug: "github",
          deviceCode: "device-code",
        }),
        connectorSlug,
      });
    }).toThrow("OAuth device provider state connector slug mismatch");
  });

  it("serializes and parses the exact canonical-only state with poll state", () => {
    const serializedState = serializeBuiltinConnectorOauthDeviceProviderState({
      connectorSlug,
      deviceCode: "device-code",
      pollState: "poll-state",
    });

    expect(serializedState).toBe(
      '{"connectorSlug":"slack","deviceCode":"device-code","pollState":"poll-state"}',
    );
    expect(
      parseBuiltinConnectorOauthDeviceProviderState({
        serializedState,
        connectorSlug,
      }),
    ).toStrictEqual({
      connectorSlug,
      deviceCode: "device-code",
      pollState: "poll-state",
    });
  });

  it("omits absent poll state from the canonical-only state", () => {
    const serializedState = serializeBuiltinConnectorOauthDeviceProviderState({
      connectorSlug,
      deviceCode: "device-code",
      pollState: undefined,
    });

    expect(serializedState).toBe(
      '{"connectorSlug":"slack","deviceCode":"device-code"}',
    );
    expect(
      parseBuiltinConnectorOauthDeviceProviderState({
        serializedState,
        connectorSlug,
      }),
    ).toStrictEqual({
      connectorSlug,
      deviceCode: "device-code",
      pollState: undefined,
    });
  });
});

describe("connector external-code provider state", () => {
  it("parses canonical state and preserves provider state", () => {
    expect(
      parseBuiltinConnectorExternalCodeProviderState({
        serializedState: JSON.stringify({
          connectorSlug,
          authMethod,
          providerState: "provider-state",
          unrelatedProperty: "ignored",
        }),
        connectorSlug,
        authMethod,
      }),
    ).toStrictEqual({
      connectorSlug,
      authMethod,
      providerState: "provider-state",
    });
  });

  it("rejects state without a connector slug", () => {
    expect(() => {
      parseBuiltinConnectorExternalCodeProviderState({
        serializedState: JSON.stringify({
          authMethod,
          providerState: "provider-state",
        }),
        connectorSlug,
        authMethod,
      });
    }).toThrow(ZodError);
  });

  it.each([
    {
      mismatch: "connector",
      serializedState: JSON.stringify({
        connectorSlug: "github",
        authMethod,
        providerState: "provider-state",
      }),
    },
    {
      mismatch: "auth method",
      serializedState: JSON.stringify({
        connectorSlug,
        authMethod: "api-key",
        providerState: "provider-state",
      }),
    },
  ])("rejects an external-code $mismatch mismatch", ({ serializedState }) => {
    expect(() => {
      parseBuiltinConnectorExternalCodeProviderState({
        serializedState,
        connectorSlug,
        authMethod,
      });
    }).toThrow("External-code provider state connector method mismatch");
  });

  it("serializes and parses the exact canonical-only state", () => {
    const serializedState = serializeBuiltinConnectorExternalCodeProviderState({
      connectorSlug,
      authMethod,
      providerState: "provider-state",
    });

    expect(serializedState).toBe(
      '{"connectorSlug":"slack","authMethod":"oauth","providerState":"provider-state"}',
    );
    expect(
      parseBuiltinConnectorExternalCodeProviderState({
        serializedState,
        connectorSlug,
        authMethod,
      }),
    ).toStrictEqual({
      connectorSlug,
      authMethod,
      providerState: "provider-state",
    });
  });
});
