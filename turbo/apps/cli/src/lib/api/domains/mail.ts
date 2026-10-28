import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  mailContract,
  type LinkMailDraftInput,
} from "@okouai/api-contracts/contracts/mail";

import { getClientConfig, handleError } from "../core/client-factory";

export async function linkMailDraft(args: LinkMailDraftInput): Promise<{
  readonly mailDraftId: string;
  readonly mailDraftUrl: string;
}> {
  const config = await getClientConfig();
  const client = initClient(mailContract, config);
  const result = await client.linkDraft({
    body: args,
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to link email draft");
}
