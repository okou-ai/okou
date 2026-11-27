import { email, string } from "zod";

export const artifactShareEmailSchema = string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(email());
