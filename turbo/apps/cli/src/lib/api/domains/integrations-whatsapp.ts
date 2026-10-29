import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { integrationsWhatsappContract } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

export class WhatsappMessageSendError extends ApiRequestError {
  constructor(
    message: string,
    code: string,
    status: number,
    readonly acceptedMessages: readonly { id: string }[],
    readonly delivery: "failed" | "unknown",
  ) {
    super(message, code, status);
  }
}

export async function sendWhatsappMessage(text: string) {
  const client = initClient(
    integrationsWhatsappContract,
    await getClientConfig(),
  );
  const result = await client.sendMessage({ headers: {}, body: { text } });
  if (result.status === 200) {
    return result.body;
  }
  if (result.status === 400 || result.status === 502) {
    throw new WhatsappMessageSendError(
      result.body.error.message,
      result.body.error.code,
      result.status,
      result.body.acceptedMessages ?? [],
      result.body.delivery ?? "unknown",
    );
  }
  handleError(result, "Failed to send WhatsApp message");
}
