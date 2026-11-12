import {
  discriminatedUnion,
  int,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { cloudflareAccessCredentialsSchema } from "./cloudflare-access-credentials";

export const customConnectorNetworkIntentSchema = discriminatedUnion("kind", [
  object({ kind: literal("direct") }).strict(),
  object({
    kind: literal("cloudflare_access"),
    configId: uuid(),
    // Observed revision for cache invalidation, not a credential selector.
    generation: int().positive().max(2_147_483_647),
  }).strict(),
]);
export type CustomConnectorNetworkIntent = zInfer<
  typeof customConnectorNetworkIntentSchema
>;

export const customConnectorNetworkAdmissionSchema = discriminatedUnion(
  "kind",
  [
    object({ kind: literal("direct") }).strict(),
    object({
      kind: literal("cloudflare_access"),
      configId: uuid(),
      generation: int().positive().max(2_147_483_647),
      headers: object({
        "CF-Access-Client-Id": cloudflareAccessCredentialsSchema.shape.clientId,
        "CF-Access-Client-Secret":
          cloudflareAccessCredentialsSchema.shape.clientSecret,
      }).strict(),
    }).strict(),
  ],
);
export type CustomConnectorNetworkAdmission = zInfer<
  typeof customConnectorNetworkAdmissionSchema
>;

export const customConnectorNetworkRequestSchema = object({
  method: string().min(1).max(32),
  url: string().min(1).max(65_536),
  intent: customConnectorNetworkIntentSchema,
}).strict();

export const customConnectorCloudflareBindingSchema = object({
  type: literal("cloudflare_access"),
  configId: uuid(),
}).strict();

export const customConnectorNetworkMetadataSchema = discriminatedUnion(
  "status",
  [
    customConnectorCloudflareBindingSchema.extend({
      status: literal("available"),
      name: string(),
      generation: int().positive().max(2_147_483_647),
    }),
    customConnectorCloudflareBindingSchema.extend({
      status: literal("unavailable"),
      name: literal(null),
    }),
  ],
);

export const cloudflareCustomConnectorReferenceSchema = object({
  id: uuid(),
  displayName: string(),
  kind: zEnum(["http", "mcp"]),
}).strict();
