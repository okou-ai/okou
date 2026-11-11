import {
  array,
  discriminatedUnion,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
} from "zod";

/** Exact admin-approved credential recipients, never host suffixes or templates. */
// Browser-shared syntax; request admission owns DNS and public-address checks.
export const customConnectorProtectedOriginSchema = string()
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      /^[a-z0-9.-]+$/u.test(url.hostname) &&
      !/^[\d.]+$/u.test(url.hostname) &&
      !url.hostname.includes(":") &&
      url.hostname.includes(".") &&
      !url.hostname.endsWith(".localhost") &&
      !url.hostname.endsWith(".local")
    );
  }, "Expected an exact public HTTPS DNS origin without a path or wildcard");
export const customConnectorProtectedOriginsSchema = array(
  customConnectorProtectedOriginSchema,
)
  .min(1)
  .max(32)
  .refine((values) => {
    return new Set(values).size === values.length;
  }, "Duplicate protected origin");

export const customConnectorCloudflareBindingSchema = object({
  type: literal("cloudflare_access"),
  configId: uuid(),
  protectedOrigins: customConnectorProtectedOriginsSchema,
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
