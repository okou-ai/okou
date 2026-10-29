import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { integrationsWhatsappContract } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { getClientConfig, handleError } from "../core/client-factory";

export async function sendWhatsappMessage(text: string) {
  const client = initClient(
    integrationsWhatsappContract,
    await getClientConfig(),
  );
  const result = await client.sendMessage({ headers: {}, body: { text } });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to send WhatsApp message");
}
