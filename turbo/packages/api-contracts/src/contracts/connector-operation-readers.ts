import { z } from "zod";

import { initContract } from "./base";
import { connectorReaderRouteSpec } from "./connector-reader-contract";
import { builtinConnectorAutomaticContract } from "./connectors";
import { builtinConnectorOauthStartResponseSchema } from "./connector-schemas";

const c = initContract();

// Only an operation-local alias may supply the operated ID. #41699 retires
// this read bridge after canonical receipt producers are serving and drained.
export const connectorCompletedOperationReaderSchema = z
  .object({
    connectionId: z.uuid().optional(),
    connectedAccountId: z.uuid().optional(),
  })
  .transform((value, context) => {
    if (
      value.connectionId !== undefined &&
      value.connectedAccountId !== undefined &&
      value.connectionId !== value.connectedAccountId
    ) {
      context.addIssue({
        code: "custom",
        message: "Connector operation account identity mismatch",
      });
      return z.NEVER;
    }
    const connectionId = value.connectionId ?? value.connectedAccountId;
    if (connectionId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Connector operation account identity is unavailable",
      });
      return z.NEVER;
    }
    return { ...value, connectionId };
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
