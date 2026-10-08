import { i18n } from "../../i18n/index.ts";

interface AgentPhoneConnectParams {
  phoneHandle: string;
  agentphoneAgentId: string;
  timestamp: number;
  signature: string;
  channel?: string;
}

interface AgentPhoneConnectParamError {
  code: "incomplete" | "invalid_signature" | "invalid_timestamp";
  title: string;
  message: string;
}

type SearchParamValue = string | string[] | undefined;
type SearchParams = URLSearchParams | Record<string, SearchParamValue>;

type ParsedAgentPhoneConnectParams =
  | {
      ok: true;
      params: AgentPhoneConnectParams;
      channel: string | null;
      returnPath: string;
    }
  | { ok: false; error: AgentPhoneConnectParamError; returnPath: string };

function firstParam(
  searchParams: SearchParams,
  key: string,
): string | undefined {
  if (searchParams instanceof URLSearchParams) {
    return searchParams.get(key) ?? undefined;
  }
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

export function isUnreliableAgentPhoneConnectChannel(
  channel: string | null | undefined,
): boolean {
  const normalized = channel?.trim().toLowerCase();
  return normalized === "sms" || normalized === "mms";
}

function encodeReturnPath(
  params: AgentPhoneConnectParams,
  channel: string | null,
): string {
  const search = new URLSearchParams({
    handle: params.phoneHandle,
    agent: params.agentphoneAgentId,
    ts: String(params.timestamp),
    sig: params.signature,
  });
  const effectiveChannel = channel ?? params.channel ?? null;
  if (effectiveChannel) {
    search.set("channel", effectiveChannel);
  }
  return `/agentphone/connect?${search.toString()}`;
}

function invalidParams(
  code: "invalid_signature" | "invalid_timestamp",
  message: string,
): ParsedAgentPhoneConnectParams {
  return {
    ok: false,
    returnPath: "/agentphone/connect",
    error: {
      code,
      title: i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.invalidTitle;
      }),
      message,
    },
  };
}

function isValidSignature(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function parseTimestamp(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0
    ? timestamp
    : undefined;
}

export function parseAgentPhoneConnectParams(
  searchParams: SearchParams,
): ParsedAgentPhoneConnectParams {
  const phoneHandle = firstParam(searchParams, "handle")?.trim();
  const agentphoneAgentId = firstParam(searchParams, "agent")?.trim();
  const tsRaw = firstParam(searchParams, "ts")?.trim();
  const signature = firstParam(searchParams, "sig")?.trim();
  const channel = firstParam(searchParams, "channel")?.trim().toLowerCase();

  if (!phoneHandle || !agentphoneAgentId || !tsRaw || !signature) {
    return {
      ok: false,
      returnPath: "/agentphone/connect",
      error: {
        code: "incomplete",
        title: i18n.t(($) => {
          return $.connectors.providerConnect.agentphone.incompleteTitle;
        }),
        message: i18n.t(($) => {
          return $.connectors.providerConnect.agentphone.incompleteDescription;
        }),
      },
    };
  }

  const timestamp = parseTimestamp(tsRaw);
  if (timestamp === undefined) {
    return invalidParams(
      "invalid_timestamp",
      i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.invalidTimestamp;
      }),
    );
  }

  if (!isValidSignature(signature)) {
    return invalidParams(
      "invalid_signature",
      i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.invalidSignature;
      }),
    );
  }

  const params: AgentPhoneConnectParams = {
    phoneHandle,
    agentphoneAgentId,
    timestamp,
    signature,
    ...(channel ? { channel } : {}),
  };

  return {
    ok: true,
    params,
    channel: channel || null,
    returnPath: encodeReturnPath(params, channel || null),
  };
}
