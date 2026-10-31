import { string } from "zod";

/**
 * Selected run model id. The API resolves the effective provider from org
 * policy and available credentials.
 */
export const runModelIdSchema = string().trim().min(1).max(255);
