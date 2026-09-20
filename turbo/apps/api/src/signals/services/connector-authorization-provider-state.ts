import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { z } from "zod";

const deviceProviderStateSchema = z
  .object({
    connectorSlug: connectorSlugSchema,
    deviceCode: z.string(),
    pollState: z.string().optional(),
  })
  .transform((state) => {
    return {
      connectorSlug: state.connectorSlug,
      deviceCode: state.deviceCode,
      pollState: state.pollState,
    };
  });

const externalCodeProviderStateSchema = z
  .object({
    connectorSlug: connectorSlugSchema,
    authMethod: connectorAuthMethodIdSchema,
    providerState: z.string(),
  })
  .transform((state) => {
    return {
      connectorSlug: state.connectorSlug,
      authMethod: state.authMethod,
      providerState: state.providerState,
    };
  });

export function parseBuiltinConnectorOauthDeviceProviderState(args: {
  readonly serializedState: string;
  readonly connectorSlug: ConnectorSlug;
}) {
  const providerState = deviceProviderStateSchema.parse(
    JSON.parse(args.serializedState) as unknown,
  );
  if (providerState.connectorSlug !== args.connectorSlug) {
    throw new Error("OAuth device provider state connector slug mismatch");
  }
  return providerState;
}

export function serializeBuiltinConnectorOauthDeviceProviderState(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly deviceCode: string;
  readonly pollState: string | undefined;
}): string {
  return JSON.stringify({
    connectorSlug: args.connectorSlug,
    deviceCode: args.deviceCode,
    ...(args.pollState === undefined ? {} : { pollState: args.pollState }),
  });
}

export function parseBuiltinConnectorExternalCodeProviderState(args: {
  readonly serializedState: string;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
}) {
  const providerState = externalCodeProviderStateSchema.parse(
    JSON.parse(args.serializedState) as unknown,
  );
  if (
    providerState.connectorSlug !== args.connectorSlug ||
    providerState.authMethod !== args.authMethod
  ) {
    throw new Error("External-code provider state connector method mismatch");
  }
  return providerState;
}

export function serializeBuiltinConnectorExternalCodeProviderState(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly providerState: string;
}): string {
  return JSON.stringify({
    connectorSlug: args.connectorSlug,
    authMethod: args.authMethod,
    providerState: args.providerState,
  });
}
