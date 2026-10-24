import { callDataRouterTool } from "../data-router-client";
import {
  peopleSearchResponseSchema,
  type PeopleSearchRequest,
  type PeopleSearchResponse,
} from "@okouai/api-contracts/contracts/people-search";

import { handleError } from "../core/client-factory";

export async function callPeopleSearch(
  body: PeopleSearchRequest,
): Promise<PeopleSearchResponse> {
  const result = await callDataRouterTool("people_search", body);
  if (result.status === 200) {
    return peopleSearchResponseSchema.parse(result.body);
  }
  handleError(result, "Failed to search for people");
}
