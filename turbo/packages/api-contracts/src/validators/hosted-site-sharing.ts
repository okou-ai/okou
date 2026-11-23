import { email, string } from "zod";

export const hostedSiteShareEmailSchema = string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(email());
