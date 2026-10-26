import { string, type infer as zInfer } from "zod";

const CONNECTOR_SLUG_MAX_LENGTH = 64;
const CONNECTOR_AUTH_METHOD_ID_MAX_LENGTH = 50;

const connectorIdentityPattern = /^[a-z0-9][a-z0-9-]*$/u;

export const connectorSlugSchema = string()
  .min(1)
  .max(CONNECTOR_SLUG_MAX_LENGTH)
  .regex(connectorIdentityPattern);

export const connectorAuthMethodIdSchema = string()
  .min(1)
  .max(CONNECTOR_AUTH_METHOD_ID_MAX_LENGTH)
  .regex(connectorIdentityPattern);

export type ConnectorSlug = zInfer<typeof connectorSlugSchema>;
export type ConnectorAuthMethodId = zInfer<typeof connectorAuthMethodIdSchema>;
