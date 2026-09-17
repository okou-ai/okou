import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { nativePublicFetch, nativePublicLookup } from "./native-http";
import { streamSimple as streamMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamBedrock } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { observePiUsageFetch, PiBedrockHttpHandler } from "./usage-transport";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

import { assertPiNativeCredential } from "./credential";
import { observeBedrockEventStreamFailures } from "./bedrock-failure-diagnostics";
import type { PiAgentStreamConfig } from "./types";
import {
  observePiResponseStatus,
  type PiAgentStreamOptions,
} from "./stream-options";
import {
  ModelRequestEventStream,
  type ModelRequestObservation,
  streamWithModelRequestDiagnostics,
} from "./model-request-diagnostics";

function isMessages(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}
function isBedrock(
  model: Model<Api>,
): model is Model<"bedrock-converse-stream"> {
  return model.api === "bedrock-converse-stream";
}

type NativeStreamConfig = Extract<
  PiAgentStreamConfig,
  {
    readonly dialect: "anthropic-messages" | "bedrock-converse-stream";
  }
>;

function assertNativeOptions(options: PiAgentStreamOptions): void {
  assertPiNativeCredential(options.apiKey ?? "");
  for (const value of Object.values(options.headers ?? {})) {
    if (value !== null && value !== undefined) assertPiNativeCredential(value);
  }
}

/** Keep catalog capabilities independent of opaque deployment/profile names. */
export function streamPiNative(
  config: NativeStreamConfig,
  model: Model<Api>,
  context: Context,
  options: PiAgentStreamOptions,
) {
  if (!config.catalogModel || config.dialect !== model.api) {
    throw new Error("Pi native stream requires its exact catalog and dialect");
  }
  assertNativeOptions(options);
  const catalogModel = config.catalogModel;
  // A Messages upstream may echo the selected opaque deployment in its result.
  // Preserve same-route signatures while the adapter uses catalog capabilities;
  // persisted history and the final request retain their upstream identity.
  const nativeContext: Context = {
    ...context,
    messages: context.messages.map((message) => {
      return message.role === "assistant" &&
        message.provider === model.provider &&
        message.api === model.api &&
        message.model === model.id
        ? { ...message, model: catalogModel }
        : message;
    }),
  };
  const nativeOptions = {
    ...options,
    maxRetries: 0,
    fetch: observePiResponseStatus(
      observePiUsageFetch(
        options.fetch ?? nativePublicFetch,
        "messages",
        options.usageObserver,
      ),
      options.onObservedResponseStatus,
    ),
    // Neither ambient cache policy nor provider authentication is inherited.
    cacheRetention: "short" as const,
    env: {},
    async onPayload(payload: unknown) {
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("Pi native request payload is invalid");
      }
      const request = {
        ...payload,
        [config.dialect === "anthropic-messages" ? "model" : "modelId"]:
          model.id,
      };
      const observed = await options.onPayload?.(request, model);
      return observed ?? request;
    },
  };
  // The upstream adapters inspect id/name while preparing thinking, tools,
  // images and cache points. Only the final request uses the upstream alias.
  if (isMessages(model)) {
    if (config.transport !== "sse") throw new Error("Pi Messages requires SSE");
    return streamWithModelRequestDiagnostics(
      (fetch) => {
        return streamMessages(
          { ...model, id: config.catalogModel },
          nativeContext,
          {
            ...nativeOptions,
            fetch,
          },
        );
      },
      nativeOptions.fetch,
      nativeOptions.signal,
    );
  }
  if (
    !isBedrock(model) ||
    config.dialect !== "bedrock-converse-stream" ||
    config.transport !== "aws-event-stream" ||
    !config.region ||
    !config.bedrockAuth
  ) {
    throw new Error(
      "Pi Bedrock requires explicit transport, region and credentials",
    );
  }
  const auth = config.bedrockAuth;
  for (const value of Object.values(auth)) assertPiNativeCredential(value);
  const proxy = resolveHttpProxyUrlForTarget(model.baseUrl);
  const observation: ModelRequestObservation = { transportAttempts: 0 };
  const requestHandler = new PiBedrockHttpHandler(
    proxy
      ? {
          httpAgent: new HttpProxyAgent(proxy),
          httpsAgent: new HttpsProxyAgent(proxy),
        }
      : {
          httpAgent: new HttpAgent({ lookup: nativePublicLookup }),
          httpsAgent: new HttpsAgent({ lookup: nativePublicLookup }),
        },
    options.usageObserver,
    observation,
    options.onObservedResponseStatus,
  );
  const source = streamBedrock(
    { ...model, id: config.catalogModel, name: config.catalogModel },
    nativeContext,
    {
      ...nativeOptions,
      clientConfig: {
        endpoint: model.baseUrl,
        region: config.region,
        maxAttempts: 1,
        requestHandler,
        eventStreamSerdeProvider:
          observeBedrockEventStreamFailures(observation),
        // Explicit credentials disable every SDK profile/role/metadata chain,
        // including bearer mode. Sandbox SigV4 uses only fake signing markers;
        // the existing Runner egress signer owns the real signing credentials.
        credentials:
          auth.kind === "sigv4"
            ? {
                accessKeyId: auth.accessKeyId,
                secretAccessKey: auth.secretAccessKey,
                ...(auth.sessionToken
                  ? { sessionToken: auth.sessionToken }
                  : {}),
              }
            : { accessKeyId: "unused", secretAccessKey: "unused" },
        authSchemePreference: [
          auth.kind === "sigv4" ? "sigv4" : "httpBearerAuth",
        ],
        ...(auth.kind === "bearer" ? { token: { token: auth.token } } : {}),
      },
    },
  );
  return new ModelRequestEventStream(source, observation);
}
