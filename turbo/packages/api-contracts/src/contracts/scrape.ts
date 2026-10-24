import { z } from "zod";

export const scrapeFormatSchema = z.enum(["markdown", "links"]);

export const scrapeModeSchema = z.enum(["standard", "enhanced"]);

export const scrapeRequestSchema = z.object({
  url: z.string().trim().url().max(2_048),
  format: scrapeFormatSchema.default("markdown"),
  mode: scrapeModeSchema.default("standard"),
});

export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;

export type ScrapeFormat = z.infer<typeof scrapeFormatSchema>;

export type ScrapeMode = z.infer<typeof scrapeModeSchema>;
