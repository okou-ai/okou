import { getDataClientConfig as getClientConfig } from "../data-router-client";
import {
  peopleSearchContract,
  type PeopleSearchRequest,
  type PeopleSearchResponse,
} from "@okouai/api-contracts/contracts/people-search";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { handleError } from "../core/client-factory";

export async function callPeopleSearch(
  body: PeopleSearchRequest,
): Promise<PeopleSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(peopleSearchContract, config);
  const result = await client.search({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to search for people");
}
