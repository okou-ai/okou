import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsWhatsappContract,
  type WhatsappFile,
} from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { ApiRequestError, getClientConfig } from "../core/client-factory";

export class WhatsappFileSendError extends ApiRequestError {
  constructor(
    message: string,
    code: string,
    status: number,
    readonly file: WhatsappFile,
    readonly delivery: "failed" | "unknown",
  ) {
    super(message, code, status);
  }
}

export async function sendWhatsappFile(
  file: WhatsappFile,
  caption: string | undefined,
) {
  const client = initClient(
    integrationsWhatsappContract,
    await getClientConfig(),
  );
  try {
    const response = await client.sendUploadedFile({
      headers: {},
      body: { fileId: file.id, ...(caption ? { caption } : {}) },
    });
    if (response.status === 200) {
      return response.body;
    }
    const details =
      response.status === 400 || response.status === 502 ? response.body : null;
    throw new WhatsappFileSendError(
      response.body.error.message,
      response.body.error.code,
      response.status,
      details?.file ?? file,
      details?.delivery ??
        (response.status >= 500 && response.body.error.code !== "NOT_CONFIGURED"
          ? "unknown"
          : "failed"),
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw new WhatsappFileSendError(
        "The WhatsApp file send has an unknown outcome. Do not retry automatically.",
        "WHATSAPP_SEND_UNKNOWN",
        502,
        file,
        "unknown",
      );
    }
    throw error;
  }
}
