import { randomUUID } from "node:crypto";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";

export type DesktopClientHeaderInjector = (headers: Headers) => void;

export function createDesktopClientHeaderInjector(options: {
  readonly clientVersion: string;
  readonly createUuid?: () => string;
}): DesktopClientHeaderInjector {
  const createUuid = options.createUuid ?? randomUUID;
  const clientSessionId = createUuid();

  return (headers) => {
    headers.set(CLIENT_VERSION_HEADER, options.clientVersion);
    headers.set(CLIENT_TYPE_HEADER, CLIENT_TYPE_DESKTOP);
    headers.set(CLIENT_SESSION_ID_HEADER, clientSessionId);
    headers.set(CLIENT_REQUEST_ID_HEADER, createUuid());
  };
}
