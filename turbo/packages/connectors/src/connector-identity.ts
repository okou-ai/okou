import * as z from "zod";

const CONNECTOR_SLUG_MAX_LENGTH = 64;
const CONNECTOR_AUTH_METHOD_ID_MAX_LENGTH = 50;

const connectorIdentityPattern = /^[a-z0-9][a-z0-9-]*$/u;

export const connectorSlugSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_SLUG_MAX_LENGTH)
  .regex(connectorIdentityPattern);

export const connectorAuthMethodIdSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_AUTH_METHOD_ID_MAX_LENGTH)
  .regex(connectorIdentityPattern);

export type ConnectorSlug = z.infer<typeof connectorSlugSchema>;
export type ConnectorAuthMethodId = z.infer<typeof connectorAuthMethodIdSchema>;
