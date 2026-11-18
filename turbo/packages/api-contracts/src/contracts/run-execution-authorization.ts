import {
  array,
  boolean,
  literal,
  number,
  object,
  record,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { CAPABILITIES, type Capability } from "./capabilities";
import { connectorSlugSchema } from "./connector-identity";
import { singleAgentRuntimeContextSchema } from "./single-agent";

function isAgentCapability(value: string): value is Capability {
  return CAPABILITIES.some((capability) => {
    return capability === value;
  });
}

/** Unknown capabilities from newer issuers cannot grant access on this API. */
export const okouTokenClaimsSchema = object({
  ...singleAgentRuntimeContextSchema.shape,
  userId: string().min(1),
  runId: string().min(1),
  orgId: string().min(1),
  iat: number(),
  exp: number(),
  capabilities: array(string().min(1))
    .transform((capabilities) => {
      return capabilities.filter(isAgentCapability);
    })
    .readonly(),
  phoneUseDeviceId: uuid().optional(),
  phoneUseGrantId: uuid().optional(),
  computerUseHostId: uuid().optional(),
  cloudBrowserEnabled: literal(true).optional(),
  customConnectorSourceIds: record(uuid(), uuid()).optional(),
  builtinConnectorSourceIds: record(connectorSlugSchema, uuid()).optional(),
});

export type OkouTokenClaims = zInfer<typeof okouTokenClaimsSchema>;

/** Admission authority only; contains no bearer credential or bypass value. */
export const runExecutionAuthorizationSchema = object({
  schemaVersion: literal(1),
  okouTokenClaims: okouTokenClaimsSchema,
  previewBypassAuthorized: boolean(),
});

export type RunExecutionAuthorization = zInfer<
  typeof runExecutionAuthorizationSchema
>;
