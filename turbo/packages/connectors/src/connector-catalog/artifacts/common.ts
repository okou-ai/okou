import { string } from "zod";

import { connectorSlugSchema } from "../../connector-identity";

export { connectorSlugSchema };

export const digestSchema = string().regex(/^sha256:[a-f0-9]{64}$/u);

export const privateNameSchema = string().regex(/^[A-Z][A-Z0-9_]*$/u);

export const connectorCatalogVersionSchema = string()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

export const artifactKeySchema = string()
  .min(1)
  .refine((key) => {
    const segments = key.split("/");
    return (
      !key.startsWith("/") &&
      !key.includes("\\") &&
      segments.every((segment) => {
        return segment.length > 0 && segment !== "." && segment !== "..";
      })
    );
  }, "Artifact keys must be relative object keys");
