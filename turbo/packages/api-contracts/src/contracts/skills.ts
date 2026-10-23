import * as z from "zod";

export const skillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
});
