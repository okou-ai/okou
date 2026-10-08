import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
const clientSessionId = crypto.randomUUID();

function createClientHeaders(clientVersion: string): Record<string, string> {
  return {
    [CLIENT_VERSION_HEADER]: clientVersion,
    [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
    [CLIENT_SESSION_ID_HEADER]: clientSessionId,
    [CLIENT_REQUEST_ID_HEADER]: crypto.randomUUID(),
  };
}

export function addClientHeaders(
  headers: Headers,
  clientVersion: string,
): void {
  for (const [key, value] of Object.entries(
    createClientHeaders(clientVersion),
  )) {
    headers.set(key, value);
  }
}
