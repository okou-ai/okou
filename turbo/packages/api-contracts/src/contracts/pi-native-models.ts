import { z } from "zod";

// Frozen Gen4 reader vocabulary, not a product availability/admission policy.
export const piNativeCatalogModelSchema = z.enum([
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
]);
