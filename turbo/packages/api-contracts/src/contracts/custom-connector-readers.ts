import { z } from "zod";

import { initContract } from "./base";
import { connectorReaderRouteSpec } from "./connector-reader-contract";
import {
  customConnectorByIdContract,
  customConnectorHttpAuthResponseSchema,
  customConnectorHttpResponseCoreSchema,
  customConnectorMcpAuthResponseSchema,
  customConnectorMcpResponseCoreSchema,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
  isIntegrationManagedCustomConnector,
} from "./custom-connectors";
import { builtinConnectorOauthStartResponseSchema } from "./connector-schemas";
import { connectorCompletedOperationReaderSchema } from "./connector-operation-readers";

const c = initContract();

// Client-only tolerance keeps the serving API's old output intact. #41699
// removes these views with old producers after App/CLI/Runner uptake and drain.
const optionalCustomProjection = {
  connected: true,
  missingRequiredFields: true,
  configuredFieldKeys: true,
} as const;

export const customConnectorManagedStatusSchema =
  customConnectorHttpResponseCoreSchema.pick({
    connected: true,
    connectedAccountId: true,
    connectedAccountUpdatedAt: true,
    missingRequiredFields: true,
    configuredFieldKeys: true,
  });

const customConnectorHttpReaderResponseSchema = z.intersection(
  customConnectorHttpResponseCoreSchema.partial(optionalCustomProjection),
  customConnectorHttpAuthResponseSchema,
);
const customConnectorMcpReaderResponseSchema = z.intersection(
  customConnectorMcpResponseCoreSchema.partial(optionalCustomProjection),
  customConnectorMcpAuthResponseSchema,
);
export const customConnectorReaderResponseSchema = z
  .union([
    customConnectorHttpReaderResponseSchema,
    customConnectorMcpReaderResponseSchema,
  ])
  .superRefine((connector, context) => {
    if (!isIntegrationManagedCustomConnector(connector)) return;
    const status = customConnectorManagedStatusSchema.safeParse(connector);
    if (!status.success) {
      for (const issue of status.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }
  });
export type CustomConnectorReaderResponse = z.infer<
  typeof customConnectorReaderResponseSchema
>;
export const customConnectorReaderListResponseSchema =
  customConnectorsContract.list.responses[200].extend({
    connectors: z.array(customConnectorReaderResponseSchema),
  });

export const setCustomConnectorValuesReaderResponseSchema =
  customConnectorReaderResponseSchema.and(
    connectorCompletedOperationReaderSchema,
  );

const customAuthorizationReaderSchema =
  builtinConnectorOauthStartResponseSchema.extend({
    result: z.literal("authorization"),
    authorizationUrl: z.url(),
  });

export const startCustomConnectorOAuth2ReaderResponseSchema = z.union([
  customAuthorizationReaderSchema,
  z
    .object({
      result: z.literal("connected"),
      connector: customConnectorReaderResponseSchema,
    })
    .and(connectorCompletedOperationReaderSchema),
]);

export const customConnectorsReaderContract = c.router({
  ...customConnectorsContract,
  list: {
    ...connectorReaderRouteSpec(customConnectorsContract.list),
    responses: {
      ...customConnectorsContract.list.responses,
      200: customConnectorReaderListResponseSchema,
    },
  },
  create: {
    ...connectorReaderRouteSpec(customConnectorsContract.create),
    responses: {
      ...customConnectorsContract.create.responses,
      201: customConnectorReaderResponseSchema,
    },
  },
});
export const customConnectorByIdReaderContract = c.router({
  ...customConnectorByIdContract,
  get: {
    ...connectorReaderRouteSpec(customConnectorByIdContract.get),
    responses: {
      ...customConnectorByIdContract.get.responses,
      200: customConnectorReaderResponseSchema,
    },
  },
  update: {
    ...connectorReaderRouteSpec(customConnectorByIdContract.update),
    responses: {
      ...customConnectorByIdContract.update.responses,
      200: customConnectorReaderResponseSchema,
    },
  },
});
export const customConnectorValuesReaderContract = c.router({
  ...customConnectorValuesContract,
  set: {
    ...connectorReaderRouteSpec(customConnectorValuesContract.set),
    responses: {
      ...customConnectorValuesContract.set.responses,
      200: setCustomConnectorValuesReaderResponseSchema,
    },
  },
});
export const customConnectorOAuth2ReaderContract = c.router({
  ...customConnectorOAuth2Contract,
  start: {
    ...connectorReaderRouteSpec(customConnectorOAuth2Contract.start),
    responses: {
      ...customConnectorOAuth2Contract.start.responses,
      200: startCustomConnectorOAuth2ReaderResponseSchema,
    },
  },
});
