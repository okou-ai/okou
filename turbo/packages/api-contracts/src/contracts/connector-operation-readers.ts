import { z } from "zod";

import { initContract } from "./base";
import { connectorReaderRouteSpec } from "./connector-reader-contract";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorExternalCodeSessionContract,
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorOauthDeviceAuthSessionContract,
} from "./connectors";
import {
  builtinConnectorOauthDeviceAuthSessionPollResponseSchema,
  builtinConnectorOauthStartResponseSchema,
} from "./connector-schemas";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";

const c = initContract();

function completedConnectionId(
  connectionId: string | undefined,
  legacyId: string | undefined,
  context: z.RefinementCtx,
): string {
  if (
    connectionId !== undefined &&
    legacyId !== undefined &&
    connectionId !== legacyId
  ) {
    context.addIssue({
      code: "custom",
      message: "Connector operation account identity mismatch",
    });
    return z.NEVER;
  }
  const operatedId = connectionId ?? legacyId;
  if (operatedId === undefined) {
    context.addIssue({
      code: "custom",
      message: "Connector operation account identity is unavailable",
    });
    return z.NEVER;
  }
  return operatedId;
}

// App/CLI readers accept operation-local IDs from still-serving old APIs.
// #41821 removes aliases once canonical API producers serve and old requests drain.
const builtinGrantReaderResponseSchema = z
  .object({
    connectionId: z.uuid().optional(),
    id: z.uuid().optional(),
    slug: connectorSlugSchema.optional(),
    authMethod: connectorAuthMethodIdSchema.optional(),
  })
  .transform((value, context) => {
    return {
      ...value,
      connectionId: completedConnectionId(
        value.connectionId,
        value.id,
        context,
      ),
    };
  });

const builtinSessionCompleteReaderResponseSchema = z
  .object({
    status: z.literal("complete"),
    connectionId: z.uuid().optional(),
    connector: z.object({ id: z.uuid() }).optional(),
  })
  .transform((value, context) => {
    return {
      status: value.status,
      connectionId: completedConnectionId(
        value.connectionId,
        value.connector?.id,
        context,
      ),
    };
  });

export const builtinConnectorManualGrantReaderContract = c.router({
  ...builtinConnectorManualGrantContract,
  connect: {
    ...connectorReaderRouteSpec(builtinConnectorManualGrantContract.connect),
    responses: {
      ...builtinConnectorManualGrantContract.connect.responses,
      200: builtinGrantReaderResponseSchema,
    },
  },
});

export const builtinConnectorNoAuthGrantReaderContract = c.router({
  ...builtinConnectorNoAuthGrantContract,
  connect: {
    ...connectorReaderRouteSpec(builtinConnectorNoAuthGrantContract.connect),
    responses: {
      ...builtinConnectorNoAuthGrantContract.connect.responses,
      200: builtinGrantReaderResponseSchema,
    },
  },
});

const [
  pendingDevicePoll,
  ,
  deniedDevicePoll,
  expiredDevicePoll,
  failedDevicePoll,
] = builtinConnectorOauthDeviceAuthSessionPollResponseSchema.options;

export const builtinConnectorOauthDeviceAuthSessionReaderContract = c.router({
  ...builtinConnectorOauthDeviceAuthSessionContract,
  poll: {
    ...connectorReaderRouteSpec(
      builtinConnectorOauthDeviceAuthSessionContract.poll,
    ),
    responses: {
      ...builtinConnectorOauthDeviceAuthSessionContract.poll.responses,
      200: z.union([
        pendingDevicePoll,
        builtinSessionCompleteReaderResponseSchema,
        deniedDevicePoll,
        expiredDevicePoll,
        failedDevicePoll,
      ]),
    },
  },
});

export const builtinConnectorExternalCodeSessionReaderContract = c.router({
  ...builtinConnectorExternalCodeSessionContract,
  complete: {
    ...connectorReaderRouteSpec(
      builtinConnectorExternalCodeSessionContract.complete,
    ),
    responses: {
      ...builtinConnectorExternalCodeSessionContract.complete.responses,
      200: builtinSessionCompleteReaderResponseSchema,
    },
  },
});

// Only an operation-local alias may supply the operated ID. #41699 retires
// this read bridge after canonical receipt producers are serving and drained.
export const connectorCompletedOperationReaderSchema = z
  .object({
    connectionId: z.uuid().optional(),
    connectedAccountId: z.uuid().optional(),
  })
  .transform((value, context) => {
    return {
      ...value,
      connectionId: completedConnectionId(
        value.connectionId,
        value.connectedAccountId,
        context,
      ),
    };
  });

const authorizationReaderSchema = builtinConnectorOauthStartResponseSchema;
const automaticConnectedReaderSchema = z
  .object({ result: z.literal("connected") })
  .and(connectorCompletedOperationReaderSchema);
export const builtinConnectorAutomaticReaderResponseSchema = z.union([
  authorizationReaderSchema.extend({ result: z.literal("authorization") }),
  automaticConnectedReaderSchema,
]);

export const builtinConnectorAutomaticReaderContract = c.router({
  ...builtinConnectorAutomaticContract,
  start: {
    ...connectorReaderRouteSpec(builtinConnectorAutomaticContract.start),
    responses: {
      ...builtinConnectorAutomaticContract.start.responses,
      200: builtinConnectorAutomaticReaderResponseSchema,
    },
  },
});
