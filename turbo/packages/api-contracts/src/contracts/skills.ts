import { object, string } from "zod";

export const skillFrontmatterSchema = object({
  name: string().optional(),
  description: string().optional(),
});
