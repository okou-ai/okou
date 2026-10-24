import { z } from "zod";
import { callDataRouterTool } from "../data-router-client";
import { handleError } from "../core/client-factory";
type WeatherOperation =
  | "current"
  | "forecast/hourly"
  | "forecast/daily"
  | "history/hourly"
  | "air-quality/current";
const weatherResponseSchema = z.object({
  operation: z.string().optional(),
  provider: z.string().optional(),
  attribution: z.string().optional(),
  creditsCharged: z.number().nullable().optional(),
  billingCategory: z.string().optional(),
  billingQuantity: z.number().optional(),
  result: z.unknown().optional(),
});
export type WeatherResponse = z.infer<typeof weatherResponseSchema>;
export async function callWeather(
  operation: WeatherOperation,
  body: Record<string, unknown>,
): Promise<WeatherResponse> {
  const result = await callDataRouterTool(
    `weather_${operation.replaceAll("/", "_").replaceAll("-", "_")}`,
    body,
  );
  if (result.status !== 200) handleError(result, "Okou Weather request failed");
  return weatherResponseSchema.parse(result.body);
}
