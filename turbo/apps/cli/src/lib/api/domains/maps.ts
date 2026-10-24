import {
  mapsSearchResponseSchema,
  type MapsSearchRequest,
  type MapsSearchResponse,
} from "@okouai/api-contracts/contracts/maps";
import { callDataRouterTool } from "../data-router-client";
import { handleError } from "../core/client-factory";
export async function callMapsSearch(
  body: MapsSearchRequest,
): Promise<MapsSearchResponse> {
  const result = await callDataRouterTool("maps_search", body);
  if (result.status !== 200) handleError(result, "Okou Maps request failed");
  return mapsSearchResponseSchema.parse(result.body);
}
