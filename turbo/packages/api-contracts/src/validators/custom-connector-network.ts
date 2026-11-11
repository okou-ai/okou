import {
  discriminatedUnion,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
} from "zod";

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
