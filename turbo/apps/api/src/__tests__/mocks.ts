import { Buffer } from "node:buffer";
import type StripeSDK from "stripe";
import type {
  BatchPublishSpec,
  BatchResult,
  BatchPublishSuccessResult,
  BatchPublishFailureResult,
  ClientOptions,
} from "ably";
import type { LookupFunction } from "node:net";
import { computed } from "ccstate";
import { ws } from "msw";
import { onTestFinished, vi, type Mock } from "vitest";
import { z } from "zod";

import { createDeferredPromise } from "../signals/utils";

import { mockStripeClient } from "../signals/external/stripe-client";

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type AblyBatchPublish = (
  spec: BatchPublishSpec,
) => Promise<
  BatchResult<BatchPublishSuccessResult | BatchPublishFailureResult>
>;
type BooleanMock = Mock<(...args: unknown[]) => boolean>;
type SignalTimerDelayOptions = { readonly signal?: AbortSignal };
type SignalTimerDelayMock = Mock<
  (ms: number, options?: SignalTimerDelayOptions) => Promise<void>
>;
type AbortSignalTimeoutMock = Mock<
  (milliseconds: number) => AbortSignal | undefined
>;
type SyncMock = Mock<(...args: unknown[]) => void>;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AxiomSdkConstructor = typeof import("@axiomhq/js").Axiom;
type AxiomSdkClient = InstanceType<AxiomSdkConstructor>;
type AxiomSdkConstructorArguments = ConstructorParameters<AxiomSdkConstructor>;
type AxiomSdkQueryBridge = (
  ...args: Parameters<AxiomSdkClient["query"]>
) => Promise<unknown>;
type ResendConstructorArguments = ConstructorParameters<
  typeof import("resend").Resend
>;
type SlackWebClientConstructorArguments = ConstructorParameters<
  typeof import("@slack/web-api").WebClient
>;
type AxiomLoggerConstructorArguments = ConstructorParameters<
  typeof import("@axiomhq/logging").Logger
>;
type AxiomJSTransportConstructorArguments = ConstructorParameters<
  typeof import("@axiomhq/logging").AxiomJSTransport
>;

function resolveDefaultStripePrice(priceId: unknown): Promise<unknown> {
  return Promise.resolve({
    id: priceId,
    active: true,
    currency: "usd",
    type: "recurring",
    unit_amount: 4200,
    recurring: { interval: "month", interval_count: 1 },
    product: "prod_test_concurrency",
  });
}

interface AxiomSdkClientMock {
  readonly options: AxiomSdkConstructorArguments[0];
  readonly flush: Mock<AxiomSdkClient["flush"]>;
  readonly ingest: Mock<AxiomSdkClient["ingest"]>;
  readonly query: Mock<AxiomSdkQueryBridge>;
}
interface BrowserUseCdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}
type BrowserUseCdpCommandMock = Mock<
  (command: BrowserUseCdpCommand) => unknown
>;
interface RequestOptionsLike {
  readonly family?: number;
  readonly headers?: RequestInit["headers"];
  readonly maxHeaderSize?: number;
  readonly method?: string;
  readonly lookup?: LookupFunction;
  readonly signal?: AbortSignal;
}

type PinnedRequestCallback = (
  response: NodeJS.ReadableStream & {
    readonly headers: Record<string, string>;
    readonly statusCode: number;
    readonly statusMessage: string;
  },
) => void;

export interface ApiTestMocks {
  readonly piSdk: {
    readonly controlInitialization: typeof controlPiSdkInitialization;
  };
  readonly abortSignal: {
    readonly timeout: AbortSignalTimeoutMock;
  };
  readonly axiom: {
    readonly useRealTelemetry: Mock<() => boolean>;
    readonly clientError: Mock<(error: Error) => void>;
    readonly clients: AxiomSdkClientMock[];
    readonly flush: AsyncMock;
    readonly ingest: BooleanMock;
    readonly query: AsyncMock;
    readonly sdkIngest: UnknownMock;
  };
  readonly axiomLogging: {
    readonly useRealTransport: Mock<() => boolean>;
    readonly debug: SyncMock;
    readonly info: SyncMock;
    readonly warn: SyncMock;
    readonly error: SyncMock;
    readonly flush: AsyncMock;
  };
  readonly console: {
    readonly capture: () => () => void;
    readonly error: SyncMock;
    readonly warn: SyncMock;
  };
  readonly ably: {
    readonly channelGet: Mock<(channelName: string) => void>;
    readonly batchPublish: Mock<AblyBatchPublish>;
    readonly useRealBatchPublish: Mock<() => boolean>;
    readonly publish: AsyncMock;
    readonly createTokenRequest: AsyncMock;
    readonly requestToken: AsyncMock;
  };
  readonly clerk: {
    readonly authenticateRequest: AsyncMock;
    readonly verifyWebhook: AsyncMock;
    readonly organizations: {
      readonly createOrganizationInvitation: AsyncMock;
      readonly getOrganization: AsyncMock;
      readonly getOrganizationInvitationList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
      readonly deleteOrganizationMembership: AsyncMock;
      readonly deleteOrganizationLogo: AsyncMock;
      readonly revokeOrganizationInvitation: AsyncMock;
      readonly deleteOrganization: AsyncMock;
      readonly updateOrganization: AsyncMock;
      readonly updateOrganizationMembership: AsyncMock;
      readonly updateOrganizationLogo: AsyncMock;
    };
    readonly users: {
      readonly getUserList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
      readonly updateUserMetadata: AsyncMock;
    };
    readonly signInTokens: {
      readonly createSignInToken: AsyncMock;
    };
    readonly m2m: {
      readonly createToken: AsyncMock;
    };
  };
  readonly browserUseCdp: {
    readonly connect: Mock<(url: string) => void>;
    readonly command: BrowserUseCdpCommandMock;
  };
  readonly s3: {
    readonly send: AsyncMock;
    readonly getSignedUrl: AsyncMock;
    readonly clientConfig: SyncMock;
  };
  readonly dns: {
    /**
     * Per-test overrides for `dns.lookup(host, { all: true })`. Hosts not
     * present here fall through to the real resolver, so DB/other connections
     * keep working. Used to exercise the import SSRF guard against hosts that
     * resolve to private addresses.
     */
    readonly lookupOverrides: Map<
      string,
      | readonly { readonly address: string; readonly family: number }[]
      | ((
          hostname: string,
        ) => readonly { readonly address: string; readonly family: number }[])
    >;
  };
  readonly nodeRequest: {
    readonly pinnedAddresses: string[];
  };
  readonly resend: {
    readonly send: AsyncMock;
  };
  readonly signalTimers: {
    readonly delay: SignalTimerDelayMock;
  };
  readonly slack: {
    readonly assistant: {
      readonly threads: {
        readonly setStatus: AsyncMock;
      };
    };
    readonly chat: {
      readonly getPermalink: AsyncMock;
      readonly postMessage: AsyncMock;
      readonly postEphemeral: AsyncMock;
    };
    readonly conversations: {
      readonly list: AsyncMock;
      readonly open: AsyncMock;
      readonly history: AsyncMock;
      readonly replies: AsyncMock;
    };
    readonly files: {
      readonly info: AsyncMock;
      readonly getUploadURLExternal: AsyncMock;
      readonly completeUploadExternal: AsyncMock;
    };
    readonly oauth: {
      readonly v2: {
        readonly access: AsyncMock;
      };
    };
    readonly views: {
      readonly publish: AsyncMock;
      readonly open: AsyncMock;
    };
    readonly users: {
      readonly info: AsyncMock;
    };
    readonly fetchFile: AsyncMock;
  };
  readonly stripe: {
    readonly events: {
      readonly list: AsyncMock;
    };
    readonly paymentMethods: {
      readonly list: AsyncMock;
      readonly retrieve: AsyncMock;
    };
    readonly invoices: {
      readonly list: AsyncMock;
      readonly listLineItems: AsyncMock;
      readonly retrieve: AsyncMock;
      readonly create: AsyncMock;
      readonly createPreview: AsyncMock;
      readonly del: AsyncMock;
      readonly finalizeInvoice: AsyncMock;
      readonly pay: AsyncMock;
      readonly voidInvoice: AsyncMock;
    };
    readonly invoiceItems: {
      readonly create: AsyncMock;
    };
    readonly refunds: {
      readonly list: AsyncMock;
      readonly create: AsyncMock;
      readonly retrieve: AsyncMock;
    };
    readonly creditNotes: {
      readonly list: AsyncMock;
      readonly preview: AsyncMock;
      readonly create: AsyncMock;
      readonly retrieve: AsyncMock;
    };
    readonly customers: {
      readonly retrieve: AsyncMock;
      readonly create: AsyncMock;
      readonly update: AsyncMock;
    };
    readonly subscriptions: {
      readonly create: AsyncMock;
      readonly list: AsyncMock;
      readonly retrieve: AsyncMock;
      readonly update: AsyncMock;
      readonly cancel: AsyncMock;
    };
    readonly subscriptionSchedules: {
      readonly retrieve: AsyncMock;
      readonly create: AsyncMock;
      readonly update: AsyncMock;
      readonly release: AsyncMock;
    };
    readonly webhooks: {
      readonly constructEvent: UnknownMock;
    };
    readonly checkout: {
      readonly sessions: {
        readonly create: AsyncMock;
        readonly retrieve: AsyncMock;
        readonly expire: AsyncMock;
      };
    };
    readonly billingPortal: {
      readonly configurations: {
        readonly list: AsyncMock;
        readonly create: AsyncMock;
        readonly update: AsyncMock;
      };
      readonly sessions: {
        readonly create: AsyncMock;
      };
    };
    readonly coupons: {
      readonly retrieve: AsyncMock;
    };
    readonly prices: {
      readonly retrieve: AsyncMock;
      readonly create: AsyncMock;
    };
  };
  readonly webpush: {
    readonly sendNotification: AsyncMock;
  };
  readonly telegram: {
    readonly getMe: AsyncMock;
    readonly getFile: AsyncMock;
    readonly deleteWebhook: AsyncMock;
    readonly setWebhook: AsyncMock;
    readonly setMyCommands: AsyncMock;
    readonly getUserProfilePhotos: AsyncMock;
  };
  readonly otel: {
    readonly registerOTel: Mock<typeof import("@vercel/otel").registerOTel>;
  };
  readonly sentry: {
    readonly captureException: SyncMock;
    readonly httpIntegration: Mock<
      typeof import("@sentry/node").httpIntegration
    >;
    readonly init: Mock<typeof import("@sentry/node").init>;
    readonly nativeNodeFetchIntegration: Mock<
      typeof import("@sentry/node").nativeNodeFetchIntegration
    >;
  };
}

interface ResendClientMock {
  readonly emails: {
    readonly send: ApiTestMocks["resend"]["send"];
  };
}
type SlackWebClientMock = Omit<ApiTestMocks["slack"], "fetchFile">;
type AxiomLoggerMock = Omit<ApiTestMocks["axiomLogging"], "useRealTransport">;
type AxiomJSTransportMock = Readonly<Record<string, never>>;

const apiTestMocks: ApiTestMocks = vi.hoisted((): ApiTestMocks => {
  const axiom = {
    useRealTelemetry: vi.fn<() => boolean>(),
    clientError: vi.fn<(error: Error) => void>(),
    clients: [],
    flush: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    ingest: vi.fn<(...args: unknown[]) => boolean>(),
    query: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    sdkIngest: vi.fn<(...args: unknown[]) => unknown>(),
  };

  const consoleWarn = vi.fn<(...args: unknown[]) => void>();
  const consoleError = vi.fn<(...args: unknown[]) => void>();
  const consoleOutput = {
    capture: (): (() => void) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(consoleWarn);
      const error = vi.spyOn(console, "error").mockImplementation(consoleError);
      return () => {
        warn.mockRestore();
        error.mockRestore();
      };
    },
    error: consoleError,
    warn: consoleWarn,
  };

  const clerk = {
    authenticateRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    verifyWebhook: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    organizations: {
      createOrganizationInvitation:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganization: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationInvitationList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      deleteOrganizationMembership:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      deleteOrganizationLogo: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      revokeOrganizationInvitation:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      deleteOrganization: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      updateOrganization: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      updateOrganizationMembership:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      updateOrganizationLogo: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    users: {
      getUserList: vi
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({ data: [] }),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      updateUserMetadata: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    signInTokens: {
      createSignInToken: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    m2m: {
      createToken: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  };

  const slack = {
    assistant: {
      threads: {
        setStatus: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
    },
    chat: {
      getPermalink: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      postMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      postEphemeral: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    conversations: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      open: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      history: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      replies: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    files: {
      info: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getUploadURLExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      completeUploadExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    oauth: {
      v2: {
        access: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
    },
    views: {
      publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      open: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    users: {
      info: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    fetchFile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  const stripe = {
    events: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    paymentMethods: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    invoices: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      listLineItems: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      createPreview: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      del: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      finalizeInvoice: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      pay: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      voidInvoice: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    invoiceItems: {
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    refunds: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    creditNotes: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      preview: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    customers: {
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    subscriptions: {
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      cancel: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    subscriptionSchedules: {
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      release: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    webhooks: {
      constructEvent: vi.fn<(...args: unknown[]) => unknown>(),
    },
    checkout: {
      sessions: {
        create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        expire: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
    },
    billingPortal: {
      configurations: {
        list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
      sessions: {
        create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
    },
    coupons: {
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    prices: {
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(
        resolveDefaultStripePrice,
      ),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  };

  const telegram = {
    getMe: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getFile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    deleteWebhook: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    setWebhook: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    setMyCommands: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getUserProfilePhotos: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  const axiomLogging = {
    useRealTransport: vi.fn<() => boolean>(),
    debug: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
    flush: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  return {
    piSdk: {
      controlInitialization: async (input, signal) => {
        return await controlPiSdkInitialization(input, signal);
      },
    },
    abortSignal: {
      timeout: vi.fn<(milliseconds: number) => AbortSignal | undefined>(),
    },
    ably: {
      channelGet: vi.fn<(channelName: string) => void>(),
      batchPublish: vi.fn<AblyBatchPublish>(),
      useRealBatchPublish: vi.fn<() => boolean>(),
      publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      createTokenRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      requestToken: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    axiom,
    axiomLogging,
    console: consoleOutput,
    browserUseCdp: {
      connect: vi.fn<(url: string) => void>(),
      command: vi.fn<(command: BrowserUseCdpCommand) => unknown>(),
    },
    clerk,
    s3: {
      send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getSignedUrl: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      clientConfig: vi.fn<(...args: unknown[]) => void>(),
    },
    dns: {
      lookupOverrides: new Map(),
    },
    nodeRequest: {
      pinnedAddresses: [],
    },
    resend: {
      send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    signalTimers: {
      delay:
        vi.fn<
          (ms: number, options?: SignalTimerDelayOptions) => Promise<void>
        >(),
    },
    slack,
    stripe,
    webpush: {
      sendNotification: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    telegram,
    otel: {
      registerOTel: vi.fn<typeof import("@vercel/otel").registerOTel>(),
    },
    sentry: {
      captureException: vi.fn<(...args: unknown[]) => void>(),
      httpIntegration: vi.fn<typeof import("@sentry/node").httpIntegration>(
        (options) => {
          return { name: "Http", options };
        },
      ),
      init: vi.fn<typeof import("@sentry/node").init>(),
      nativeNodeFetchIntegration: vi.fn<
        typeof import("@sentry/node").nativeNodeFetchIntegration
      >((options) => {
        return { name: "NodeFetch", options };
      }),
    },
  };
});

const originalAbortSignalTimeout = AbortSignal.timeout.bind(AbortSignal);
vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
  return (
    apiTestMocks.abortSignal.timeout(milliseconds) ??
    originalAbortSignalTimeout(milliseconds)
  );
});

const browserUseCdpCommandSchema = z.object({
  id: z.number().int(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
  sessionId: z.string().optional(),
});

function defaultBrowserUseCdpResult(command: BrowserUseCdpCommand): unknown {
  if (command.method === "Target.getTargets") {
    return {
      targetInfos: [
        { targetId: "page-target", type: "page", url: "about:blank" },
      ],
    };
  }
  if (command.method === "Browser.getWindowForTarget") {
    return { windowId: 7 };
  }
  return {};
}

export function browserUseCdpHandler(url: string) {
  const cdp = ws.link(url);
  return cdp.addEventListener("connection", ({ client }) => {
    apiTestMocks.browserUseCdp.connect(url);
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        throw new Error("Expected a text CDP command");
      }
      const command = browserUseCdpCommandSchema.parse(JSON.parse(event.data));
      const mockedResult = apiTestMocks.browserUseCdp.command(command);
      if (mockedResult instanceof Error) {
        client.send(
          JSON.stringify({
            id: command.id,
            error: { message: mockedResult.message },
          }),
        );
        return;
      }
      client.send(
        JSON.stringify({
          id: command.id,
          result: mockedResult ?? defaultBrowserUseCdpResult(command),
        }),
      );
    });
  });
}

vi.mock("@aws-sdk/client-s3", () => {
  class AbortMultipartUploadCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class CompleteMultipartUploadCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class CopyObjectCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class CreateMultipartUploadCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class GetObjectCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class HeadObjectCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class ListObjectsV2Command {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class ListPartsCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class DeleteObjectsCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class PutObjectCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class S3Client {
    constructor(config: unknown) {
      apiTestMocks.s3.clientConfig(config);
    }

    send(command: unknown): Promise<unknown> {
      return apiTestMocks.s3.send(command);
    }
  }

  class UploadPartCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CopyObjectCommand,
    CreateMultipartUploadCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    ListPartsCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => {
  return {
    getSignedUrl: (...args: unknown[]): Promise<unknown> => {
      return apiTestMocks.s3.getSignedUrl(...args);
    },
  };
});

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: (hostname: string, options?: unknown): Promise<unknown> => {
      const override = apiTestMocks.dns.lookupOverrides.get(hostname);
      if (!override) {
        return actual.lookup(hostname, options as never);
      }
      const resolved =
        typeof override === "function" ? override(hostname) : override;
      const wantsAll =
        typeof options === "object" &&
        options !== null &&
        (options as { all?: boolean }).all === true;
      return Promise.resolve(wantsAll ? resolved : resolved[0]);
    },
  };
});

function isPinnedRequest(
  args: readonly unknown[],
): args is readonly [URL, RequestOptionsLike, PinnedRequestCallback] {
  const [url, options, callback] = args;
  return (
    url instanceof URL &&
    typeof options === "object" &&
    options !== null &&
    typeof (options as RequestOptionsLike).lookup === "function" &&
    typeof callback === "function"
  );
}

async function mockPinnedRequestModule<TModule extends object>(
  importOriginal: () => Promise<TModule>,
) {
  const actual = await importOriginal();
  const actualRequest = (actual as { request: (...args: unknown[]) => unknown })
    .request;
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  const request = (...args: unknown[]) => {
    if (!isPinnedRequest(args)) {
      return actualRequest(...args);
    }
    const [url, options, callback] = args;
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & {
      end: (body?: string | Uint8Array) => void;
    };
    req.end = (requestBody?: string | Uint8Array) => {
      queueMicrotask(() => {
        void (async () => {
          if (options.family === 4 || options.family === 6) {
            options.lookup?.(
              url.hostname,
              { family: options.family },
              (error, address) => {
                if (error) {
                  throw error;
                }
                if (typeof address !== "string") {
                  throw new TypeError("Expected a single pinned IP address");
                }
                apiTestMocks.nodeRequest.pinnedAddresses.push(address);
              },
            );
          } else {
            options.lookup?.(
              url.hostname,
              { all: true },
              (error, addresses) => {
                if (error) {
                  throw error;
                }
                if (!Array.isArray(addresses)) {
                  throw new TypeError(
                    "Expected an array of pinned IP addresses",
                  );
                }
                for (const address of addresses) {
                  apiTestMocks.nodeRequest.pinnedAddresses.push(
                    address.address,
                  );
                }
              },
            );
          }
          const fetched = await fetch(url, {
            method: options.method,
            headers: options.headers,
            body:
              options.method === "GET" || options.method === "HEAD"
                ? undefined
                : requestBody,
            redirect: "manual",
            signal: options.signal,
          });
          const headers: Record<string, string> = {};
          for (const [key, value] of fetched.headers) {
            headers[key] = value;
          }
          const responseHeaderBytes = Object.entries(headers).reduce(
            (bytes, [name, value]) => {
              return bytes + Buffer.byteLength(`${name}: ${value}\r\n`);
            },
            2,
          );
          if (
            options.maxHeaderSize !== undefined &&
            responseHeaderBytes > options.maxHeaderSize
          ) {
            throw new Error("Parse Error: Header overflow");
          }
          const body = fetched.body
            ? Readable.from([new Uint8Array(await fetched.arrayBuffer())])
            : Readable.from([]);
          callback(
            Object.assign(body, {
              headers,
              statusCode: fetched.status,
              statusMessage: fetched.statusText,
            }),
          );
        })().catch((error: unknown) => {
          req.emit("error", error);
        });
      });
    };
    return req;
  };
  return { ...actual, request };
}

vi.mock("node:https", async (importOriginal) => {
  return await mockPinnedRequestModule(
    importOriginal as () => Promise<typeof import("node:https")>,
  );
});

vi.mock("node:http", async (importOriginal) => {
  return await mockPinnedRequestModule(
    importOriginal as () => Promise<typeof import("node:http")>,
  );
});

vi.mock("@clerk/backend", () => {
  return {
    createClerkClient: () => {
      return apiTestMocks.clerk;
    },
  };
});

vi.mock("@clerk/backend/webhooks", () => {
  return {
    verifyWebhook: (...args: unknown[]): Promise<unknown> => {
      return apiTestMocks.clerk.verifyWebhook(...args);
    },
  };
});

vi.mock("web-push", async (importActual) => {
  const actual = await importActual<typeof import("web-push")>();
  return {
    ...actual,
    default: {
      sendNotification: (...args: unknown[]): Promise<unknown> => {
        return apiTestMocks.webpush.sendNotification(...args);
      },
    },
    sendNotification: (...args: unknown[]): Promise<unknown> => {
      return apiTestMocks.webpush.sendNotification(...args);
    },
  };
});

vi.mock("resend", () => {
  return {
    Resend: vi.fn<(...args: ResendConstructorArguments) => ResendClientMock>(
      function () {
        const client: ResendClientMock = {
          emails: {
            send: apiTestMocks.resend.send,
          },
        };
        return client;
      },
    ),
  };
});

vi.mock("signal-timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("signal-timers")>();
  return {
    ...actual,
    delay: (ms: number, options?: SignalTimerDelayOptions): Promise<void> => {
      if (apiTestMocks.signalTimers.delay.getMockImplementation()) {
        return apiTestMocks.signalTimers.delay(ms, options);
      }
      return actual.delay(ms, options);
    },
  };
});

vi.mock("ably", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ably")>();
  class MockRest {
    constructor(private readonly options: ClientOptions) {}

    readonly batchPublish: AblyBatchPublish = async (spec) => {
      const mocked = apiTestMocks.ably.batchPublish(spec);
      if (apiTestMocks.ably.useRealBatchPublish()) {
        return await new actual.Rest(this.options).batchPublish(spec);
      }
      if (mocked !== undefined) {
        return await mocked;
      }
      return {
        successCount: spec.channels.length,
        failureCount: 0,
        results: spec.channels.map((channel) => {
          return {
            channel,
            messageId: "test-batch",
            serials: spec.messages.map(() => {
              return null;
            }),
          };
        }),
      };
    };
    readonly channels = {
      get: (channelName: string) => {
        apiTestMocks.ably.channelGet(channelName);
        return { publish: apiTestMocks.ably.publish };
      },
    };
    readonly auth = {
      createTokenRequest: (...args: unknown[]): Promise<unknown> => {
        return apiTestMocks.ably.createTokenRequest(...args);
      },
      requestToken: (...args: unknown[]): Promise<unknown> => {
        return apiTestMocks.ably.requestToken(...args);
      },
    };
  }
  return { default: { Rest: MockRest } };
});

vi.mock("@sentry/node", () => {
  return apiTestMocks.sentry;
});

vi.mock("@vercel/otel", () => {
  return apiTestMocks.otel;
});

vi.mock("stripe", async (importOriginal) => {
  // Preserve the real `Stripe.errors.*` classes so route-level `instanceof`
  // checks (and tests constructing `new Stripe.errors.StripeInvalidRequestError`)
  // continue to work; only the constructor surface is stubbed.
  const actual = await importOriginal<typeof import("stripe")>();
  const MockStripe = Object.assign(
    vi.fn(() => {
      return {
        events: {
          list: apiTestMocks.stripe.events.list,
        },
        paymentMethods: {
          list: apiTestMocks.stripe.paymentMethods.list,
          retrieve: apiTestMocks.stripe.paymentMethods.retrieve,
        },
        invoices: {
          list: apiTestMocks.stripe.invoices.list,
          listLineItems: apiTestMocks.stripe.invoices.listLineItems,
          retrieve: apiTestMocks.stripe.invoices.retrieve,
          create: apiTestMocks.stripe.invoices.create,
          createPreview: apiTestMocks.stripe.invoices.createPreview,
          del: apiTestMocks.stripe.invoices.del,
          finalizeInvoice: apiTestMocks.stripe.invoices.finalizeInvoice,
          pay: apiTestMocks.stripe.invoices.pay,
          voidInvoice: apiTestMocks.stripe.invoices.voidInvoice,
        },
        invoiceItems: {
          create: apiTestMocks.stripe.invoiceItems.create,
        },
        refunds: {
          list: apiTestMocks.stripe.refunds.list,
          create: apiTestMocks.stripe.refunds.create,
          retrieve: apiTestMocks.stripe.refunds.retrieve,
        },
        creditNotes: {
          list: apiTestMocks.stripe.creditNotes.list,
          preview: apiTestMocks.stripe.creditNotes.preview,
          create: apiTestMocks.stripe.creditNotes.create,
          retrieve: apiTestMocks.stripe.creditNotes.retrieve,
        },
        customers: {
          retrieve: apiTestMocks.stripe.customers.retrieve,
          create: apiTestMocks.stripe.customers.create,
          update: apiTestMocks.stripe.customers.update,
        },
        subscriptions: {
          create: apiTestMocks.stripe.subscriptions.create,
          list: apiTestMocks.stripe.subscriptions.list,
          retrieve: apiTestMocks.stripe.subscriptions.retrieve,
          update: apiTestMocks.stripe.subscriptions.update,
          cancel: apiTestMocks.stripe.subscriptions.cancel,
        },
        subscriptionSchedules: {
          retrieve: apiTestMocks.stripe.subscriptionSchedules.retrieve,
          create: apiTestMocks.stripe.subscriptionSchedules.create,
          update: apiTestMocks.stripe.subscriptionSchedules.update,
          release: apiTestMocks.stripe.subscriptionSchedules.release,
        },
        webhooks: {
          constructEvent: apiTestMocks.stripe.webhooks.constructEvent,
        },
        checkout: {
          sessions: {
            create: apiTestMocks.stripe.checkout.sessions.create,
            retrieve: apiTestMocks.stripe.checkout.sessions.retrieve,
            expire: apiTestMocks.stripe.checkout.sessions.expire,
          },
        },
        billingPortal: {
          configurations: {
            list: apiTestMocks.stripe.billingPortal.configurations.list,
            create: apiTestMocks.stripe.billingPortal.configurations.create,
            update: apiTestMocks.stripe.billingPortal.configurations.update,
          },
          sessions: {
            create: apiTestMocks.stripe.billingPortal.sessions.create,
          },
        },
        coupons: {
          retrieve: apiTestMocks.stripe.coupons.retrieve,
        },
        prices: {
          retrieve: apiTestMocks.stripe.prices.retrieve,
          create: apiTestMocks.stripe.prices.create,
        },
      };
    }),
    { errors: actual.default.errors },
  );
  return { default: MockStripe };
});

vi.mock("@slack/web-api", () => {
  return {
    WebClient: vi.fn<
      (...args: SlackWebClientConstructorArguments) => SlackWebClientMock
    >(function () {
      const client: SlackWebClientMock = {
        assistant: {
          threads: {
            setStatus: apiTestMocks.slack.assistant.threads.setStatus,
          },
        },
        chat: {
          getPermalink: apiTestMocks.slack.chat.getPermalink,
          postMessage: apiTestMocks.slack.chat.postMessage,
          postEphemeral: apiTestMocks.slack.chat.postEphemeral,
        },
        conversations: {
          list: apiTestMocks.slack.conversations.list,
          open: apiTestMocks.slack.conversations.open,
          history: apiTestMocks.slack.conversations.history,
          replies: apiTestMocks.slack.conversations.replies,
        },
        files: {
          info: apiTestMocks.slack.files.info,
          getUploadURLExternal: apiTestMocks.slack.files.getUploadURLExternal,
          completeUploadExternal:
            apiTestMocks.slack.files.completeUploadExternal,
        },
        oauth: {
          v2: {
            access: apiTestMocks.slack.oauth.v2.access,
          },
        },
        views: {
          publish: apiTestMocks.slack.views.publish,
          open: apiTestMocks.slack.views.open,
        },
        users: {
          info: apiTestMocks.slack.users.info,
        },
      };
      return client;
    }),
  };
});

vi.mock("../signals/external/slack-file-fetcher", async () => {
  const actual = await vi.importActual<
    typeof import("../signals/external/slack-file-fetcher")
  >("../signals/external/slack-file-fetcher");
  return {
    ...actual,
    fetchSlackFile: apiTestMocks.slack.fetchFile,
  };
});

vi.mock("../signals/external/telegram-client", async () => {
  const actual = await vi.importActual<
    typeof import("../signals/external/telegram-client")
  >("../signals/external/telegram-client");
  return {
    ...actual,
    getMe: apiTestMocks.telegram.getMe,
    getFile: apiTestMocks.telegram.getFile,
    deleteWebhook: apiTestMocks.telegram.deleteWebhook,
    setWebhook: apiTestMocks.telegram.setWebhook,
    setMyCommands: apiTestMocks.telegram.setMyCommands,
    getUserProfilePhotos: apiTestMocks.telegram.getUserProfilePhotos,
  };
});

vi.mock("../signals/external/axiom", async () => {
  const actual = await vi.importActual<
    typeof import("../signals/external/axiom")
  >("../signals/external/axiom");
  return {
    ...actual,
    // Wrap the underlying vi.fn() in a ccstate `computed` so `get(queryAxiom(apl))`
    // resolves correctly. Tests configure responses via
    // `context.mocks.axiom.query.mockResolvedValue(...)`. The optional
    // The optional `options` second arg is forwarded so tests can assert on
    // pagination options via `expect(...).toHaveBeenCalledWith(apl, opts)`.
    queryAxiom: (apl: string, options?: unknown) => {
      return computed(() => {
        return apiTestMocks.axiom.query(apl, options);
      });
    },
    getDatasetName: (name: string) => {
      return apiTestMocks.axiom.useRealTelemetry()
        ? actual.getDatasetName(name)
        : name;
    },
    ingestToAxiom: (
      dataset: string,
      events: readonly Record<string, unknown>[],
    ) => {
      return apiTestMocks.axiom.useRealTelemetry()
        ? actual.ingestToAxiom(dataset, events)
        : apiTestMocks.axiom.ingest(dataset, events);
    },
    flushAxiom: (options?: Parameters<typeof actual.flushAxiom>[0]) => {
      return apiTestMocks.axiom.useRealTelemetry()
        ? actual.flushAxiom(options)
        : apiTestMocks.axiom.flush(options);
    },
  };
});

async function createAxiomSdkMock() {
  const actual =
    await vi.importActual<typeof import("@axiomhq/js")>("@axiomhq/js");
  return {
    Axiom: vi.fn<
      (
        ...args: AxiomSdkConstructorArguments
      ) => AxiomSdkClientMock | AxiomSdkClient
    >(function (options) {
      if (apiTestMocks.axiomLogging.useRealTransport()) {
        return new actual.Axiom(options);
      }
      apiTestMocks.axiom.clientError.mockImplementation((error: Error) => {
        options.onError?.(error);
      });
      const client: AxiomSdkClientMock = {
        options,
        flush: vi.fn<AxiomSdkClient["flush"]>(async (...args) => {
          await apiTestMocks.axiom.flush(...args);
        }),
        ingest: vi.fn<AxiomSdkClient["ingest"]>((...args) => {
          apiTestMocks.axiom.sdkIngest(...args);
        }),
        query: vi.fn<AxiomSdkQueryBridge>((...args) => {
          return apiTestMocks.axiom.query(...args);
        }),
      };
      apiTestMocks.axiom.clients.push(client);
      return client;
    }),
  };
}

vi.mock("@axiomhq/js", createAxiomSdkMock);

async function createAxiomLoggingMock() {
  const actual =
    await vi.importActual<typeof import("@axiomhq/logging")>(
      "@axiomhq/logging",
    );
  return {
    EVENT: actual.EVENT,
    Logger: vi.fn<
      (
        ...args: AxiomLoggerConstructorArguments
      ) => AxiomLoggerMock | InstanceType<typeof actual.Logger>
    >(function (...args) {
      if (apiTestMocks.axiomLogging.useRealTransport()) {
        return new actual.Logger(...args);
      }
      const logger: AxiomLoggerMock = {
        debug: apiTestMocks.axiomLogging.debug,
        info: apiTestMocks.axiomLogging.info,
        warn: apiTestMocks.axiomLogging.warn,
        error: apiTestMocks.axiomLogging.error,
        flush: apiTestMocks.axiomLogging.flush,
      };
      return logger;
    }),
    AxiomJSTransport: vi.fn<
      (
        ...args: AxiomJSTransportConstructorArguments
      ) => AxiomJSTransportMock | InstanceType<typeof actual.AxiomJSTransport>
    >(function (...args) {
      if (apiTestMocks.axiomLogging.useRealTransport()) {
        return new actual.AxiomJSTransport(...args);
      }
      const transport: AxiomJSTransportMock = {};
      return transport;
    }),
  };
}

vi.mock("@axiomhq/logging", createAxiomLoggingMock);

// Logging integration tests import the application logger after entering this
// scope so both SDKs and the logger's cached instances belong to that test.
export async function withRealAxiomLoggingForTest(
  runTest: () => Promise<void>,
): Promise<void> {
  vi.doUnmock("@axiomhq/logging");
  vi.doUnmock("@axiomhq/js");
  vi.resetModules();
  await Promise.resolve()
    .then(runTest)
    .finally(() => {
      vi.doMock("@axiomhq/js", createAxiomSdkMock);
      vi.doMock("@axiomhq/logging", createAxiomLoggingMock);
      vi.resetModules();
    });
}

// A telemetry write that fails is not a diagnostic: production decides whether
// the request survives it, and `external/axiom.ts` plus
// `external/sandbox-op-log.ts` own the guards that make that decision. Both
// reach Axiom through this file's `@axiomhq/js` stub, so the only faithful
// place to break a write is that SDK boundary; replacing the wrappers instead
// lets the error escape where production never sees it. Routing through the
// real wrappers is part of the failure mode, not a separate step, so this
// helper enables them. Tests name the datasets to break and assert the HTTP
// response and the effect afterwards; no event payload is handed back.
type AxiomSdkTelemetryFailure =
  // `datasets` lists exact Axiom dataset names, including the
  // `AXIOM_DATASET_SUFFIX`. Omit it to fail every ingest.
  | { readonly mode: "ingest"; readonly datasets?: readonly string[] }
  // The SDK flushes a client, not a dataset, so this mode takes no filter.
  | { readonly mode: "flush" };

export function mockAxiomSdkTelemetryFailure(
  failure: AxiomSdkTelemetryFailure,
): void {
  apiTestMocks.axiom.useRealTelemetry.mockReturnValue(true);
  if (failure.mode === "flush") {
    apiTestMocks.axiom.flush.mockRejectedValue(
      new Error("Axiom SDK flush failed"),
    );
    return;
  }
  const datasets = failure.datasets;
  apiTestMocks.axiom.sdkIngest.mockImplementation((dataset: unknown) => {
    if (
      datasets === undefined ||
      (typeof dataset === "string" && datasets.includes(dataset))
    ) {
      throw new Error("Axiom SDK ingest failed");
    }
    return undefined;
  });
}

/**
 * Only the SDK can delay session initialization after resource loading. The
 * fixture calls its real methods and matches a unique session/instruction pair;
 * route tests still create runs and inspect outcomes through production APIs.
 */
async function controlPiSdkInitialization(
  input: {
    readonly sessionId: string;
    readonly instructions: string;
    readonly holdInitialization: boolean;
    readonly initializationFailure?: Error;
  },
  signal: AbortSignal,
) {
  const { AgentSession, DefaultResourceLoader, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  type AgentSessionInstance = InstanceType<typeof AgentSession>;
  type ResourceLoaderInstance = InstanceType<typeof DefaultResourceLoader>;
  type SettingsManagerInstance = ReturnType<typeof SettingsManager.inMemory>;
  const entered = createDeferredPromise<void>(signal);
  const ready = createDeferredPromise<void>(signal);
  const disposed = createDeferredPromise<void>(signal);
  const failed = createDeferredPromise<Error>(signal);
  const release = createDeferredPromise<void>(signal);
  let sessionSettings: SettingsManagerInstance | undefined;
  let initializationCount = 0;
  let disposeCount = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  const originalThinkingLevel:
    | ((this: AgentSessionInstance) => AgentSessionInstance["thinkingLevel"])
    | undefined = Object.getOwnPropertyDescriptor(
    AgentSession.prototype,
    "thinkingLevel",
  )?.get;
  if (!originalThinkingLevel) {
    throw new Error("Expected the official Pi session thinking-level getter");
  }
  const originalCompactionSettings =
    SettingsManager.prototype.getCompactionSettings;
  const originalDispose = AgentSession.prototype.dispose;
  const thinkingSpy = vi.spyOn(AgentSession.prototype, "thinkingLevel", "get");

  const reloadSpy = vi
    .spyOn(DefaultResourceLoader.prototype, "reload")
    .mockImplementation(async function (this: ResourceLoaderInstance, options) {
      await originalReload.call(this, options);
      if (
        this.getAgentsFiles().agentsFiles.some((file) => {
          return file.content === input.instructions;
        })
      ) {
        initializationCount += 1;
        if (!entered.settled()) {
          entered.resolve(undefined);
        }
        // The production attempt cannot abort this test-owned SDK gate. Its
        // late session must still be released when the test permits completion.
        await release.promise;
        if (input.initializationFailure) {
          if (!failed.settled()) {
            failed.resolve(input.initializationFailure);
          }
          throw input.initializationFailure;
        }
      }
    });
  thinkingSpy.mockImplementation(function (this: AgentSessionInstance) {
    if (this.sessionId === input.sessionId) {
      sessionSettings = this.settingsManager;
    }
    return originalThinkingLevel.call(this);
  });
  const compactionSpy = vi
    .spyOn(SettingsManager.prototype, "getCompactionSettings")
    .mockImplementation(function (this: SettingsManagerInstance) {
      const settings = originalCompactionSettings.call(this);
      if (this === sessionSettings) {
        // The created SDK session has been finalized; this is the final
        // synchronous preflight before the prepared turn is returned.
        if (!ready.settled()) {
          ready.resolve(undefined);
        }
      }
      return settings;
    });
  const disposeSpy = vi
    .spyOn(AgentSession.prototype, "dispose")
    .mockImplementation(function (this: AgentSessionInstance) {
      originalDispose.call(this);
      if (this.sessionId === input.sessionId) {
        disposeCount += 1;
        if (!disposed.settled()) {
          disposed.resolve(undefined);
        }
      }
    });

  const releaseInitialization = () => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
  };
  if (!input.holdInitialization) {
    releaseInitialization();
  }
  onTestFinished(() => {
    releaseInitialization();
    reloadSpy.mockRestore();
    thinkingSpy.mockRestore();
    compactionSpy.mockRestore();
    disposeSpy.mockRestore();
  });

  return {
    entered: entered.promise,
    ready: ready.promise,
    disposed: disposed.promise,
    failed: failed.promise,
    release: releaseInitialization,
    initializationCount: () => {
      return initializationCount;
    },
    disposeCount: () => {
      return disposeCount;
    },
  };
}

export function getApiTestMocks(): ApiTestMocks {
  return apiTestMocks;
}

export function apiTestS3PresignedUrl(command: unknown): string {
  const candidate = command as {
    readonly constructor?: { readonly name?: string };
    readonly input?: { readonly Bucket?: unknown; readonly Key?: unknown };
  };
  if (candidate.constructor?.name !== "GetObjectCommand") {
    return "https://r2.example.com/upload?sig=test";
  }
  const bucket = candidate.input?.Bucket;
  const key = candidate.input?.Key;
  if (typeof bucket !== "string" || typeof key !== "string") {
    throw new Error("Expected S3 GET presign request to identify an object");
  }
  const url = new URL("https://r2.example.com/storage/archive.tar.gz");
  url.searchParams.set("sig", "bdd");
  url.searchParams.set("object", `${bucket}/${key}`);
  return url.toString();
}

export function resetApiTestMocks(): void {
  apiTestMocks.abortSignal.timeout.mockReset();
  apiTestMocks.ably.channelGet.mockReset();
  apiTestMocks.ably.batchPublish.mockReset();
  apiTestMocks.ably.useRealBatchPublish.mockReset();
  apiTestMocks.ably.publish.mockReset();
  apiTestMocks.ably.publish.mockResolvedValue(undefined);
  apiTestMocks.ably.createTokenRequest.mockReset();
  apiTestMocks.ably.requestToken.mockReset();
  apiTestMocks.ably.requestToken.mockResolvedValue({
    token: "test-ably-token",
  });
  apiTestMocks.axiom.useRealTelemetry.mockReset();
  apiTestMocks.axiom.useRealTelemetry.mockReturnValue(false);
  apiTestMocks.axiom.clientError.mockReset();
  apiTestMocks.axiom.clients.splice(0);
  apiTestMocks.axiom.flush.mockReset();
  apiTestMocks.axiom.ingest.mockReset();
  apiTestMocks.axiom.ingest.mockReturnValue(true);
  apiTestMocks.axiom.query.mockReset();
  apiTestMocks.axiom.sdkIngest.mockReset();
  apiTestMocks.axiomLogging.useRealTransport.mockReset();
  apiTestMocks.axiomLogging.useRealTransport.mockReturnValue(false);
  apiTestMocks.axiomLogging.debug.mockReset();
  apiTestMocks.axiomLogging.info.mockReset();
  apiTestMocks.axiomLogging.warn.mockReset();
  apiTestMocks.axiomLogging.error.mockReset();
  apiTestMocks.axiomLogging.flush.mockReset();
  apiTestMocks.console.error.mockReset();
  apiTestMocks.console.warn.mockReset();
  apiTestMocks.browserUseCdp.connect.mockReset();
  apiTestMocks.browserUseCdp.command.mockReset();
  apiTestMocks.clerk.authenticateRequest.mockReset();
  apiTestMocks.clerk.verifyWebhook.mockReset();
  apiTestMocks.clerk.organizations.createOrganizationInvitation.mockReset();
  apiTestMocks.clerk.organizations.getOrganization.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationInvitationList.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationMembershipList.mockReset();
  apiTestMocks.clerk.organizations.deleteOrganizationLogo.mockReset();
  apiTestMocks.clerk.organizations.deleteOrganizationMembership.mockReset();
  apiTestMocks.clerk.organizations.revokeOrganizationInvitation.mockReset();
  apiTestMocks.clerk.organizations.deleteOrganization.mockReset();
  apiTestMocks.clerk.organizations.updateOrganization.mockReset();
  apiTestMocks.clerk.organizations.updateOrganizationMembership.mockReset();
  apiTestMocks.clerk.organizations.updateOrganizationLogo.mockReset();
  apiTestMocks.clerk.users.getUserList.mockReset();
  apiTestMocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
  apiTestMocks.clerk.users.getOrganizationMembershipList.mockReset();
  apiTestMocks.clerk.users.updateUserMetadata.mockReset();
  apiTestMocks.clerk.signInTokens.createSignInToken.mockReset();
  apiTestMocks.clerk.m2m.createToken.mockReset();
  apiTestMocks.s3.send.mockReset();
  apiTestMocks.s3.getSignedUrl.mockReset();
  apiTestMocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      return Promise.resolve(apiTestS3PresignedUrl(command));
    },
  );
  apiTestMocks.s3.clientConfig.mockReset();
  apiTestMocks.dns.lookupOverrides.clear();
  apiTestMocks.nodeRequest.pinnedAddresses.length = 0;
  apiTestMocks.resend.send.mockReset();
  apiTestMocks.signalTimers.delay.mockReset();
  apiTestMocks.slack.assistant.threads.setStatus.mockReset();
  apiTestMocks.slack.chat.getPermalink.mockReset();
  apiTestMocks.slack.chat.postMessage.mockReset();
  apiTestMocks.slack.chat.postEphemeral.mockReset();
  apiTestMocks.slack.conversations.list.mockReset();
  apiTestMocks.slack.conversations.open.mockReset();
  apiTestMocks.slack.conversations.history.mockReset();
  apiTestMocks.slack.conversations.replies.mockReset();
  apiTestMocks.slack.files.info.mockReset();
  apiTestMocks.slack.files.getUploadURLExternal.mockReset();
  apiTestMocks.slack.files.completeUploadExternal.mockReset();
  apiTestMocks.slack.oauth.v2.access.mockReset();
  apiTestMocks.slack.views.publish.mockReset();
  apiTestMocks.slack.views.open.mockReset();
  apiTestMocks.slack.users.info.mockReset();
  apiTestMocks.slack.fetchFile.mockReset();
  apiTestMocks.stripe.paymentMethods.list.mockReset();
  apiTestMocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
  apiTestMocks.stripe.invoices.list.mockReset();
  apiTestMocks.stripe.invoices.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  apiTestMocks.stripe.events.list.mockReset();
  apiTestMocks.stripe.events.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  apiTestMocks.stripe.invoices.listLineItems.mockReset();
  apiTestMocks.stripe.invoices.listLineItems.mockResolvedValue({
    data: [],
    has_more: false,
  });
  apiTestMocks.stripe.invoices.retrieve.mockReset();
  apiTestMocks.stripe.invoices.create.mockReset();
  apiTestMocks.stripe.invoices.createPreview.mockReset();
  apiTestMocks.stripe.invoices.finalizeInvoice.mockReset();
  apiTestMocks.stripe.invoices.pay.mockReset();
  apiTestMocks.stripe.invoices.voidInvoice.mockReset();
  apiTestMocks.stripe.invoiceItems.create.mockReset();
  apiTestMocks.stripe.refunds.list.mockReset();
  apiTestMocks.stripe.refunds.create.mockReset();
  apiTestMocks.stripe.refunds.retrieve.mockReset();
  apiTestMocks.stripe.creditNotes.list.mockReset();
  apiTestMocks.stripe.creditNotes.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  apiTestMocks.stripe.creditNotes.preview.mockReset();
  apiTestMocks.stripe.creditNotes.create.mockReset();
  apiTestMocks.stripe.creditNotes.retrieve.mockReset();
  apiTestMocks.stripe.customers.retrieve.mockReset();
  apiTestMocks.stripe.customers.create.mockReset();
  apiTestMocks.stripe.customers.update.mockReset();
  apiTestMocks.stripe.paymentMethods.retrieve.mockReset();
  apiTestMocks.stripe.subscriptions.create.mockReset();
  apiTestMocks.stripe.subscriptions.list.mockReset();
  apiTestMocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
  apiTestMocks.stripe.subscriptions.retrieve.mockReset();
  apiTestMocks.stripe.subscriptions.update.mockReset();
  apiTestMocks.stripe.subscriptions.cancel.mockReset();
  apiTestMocks.stripe.subscriptionSchedules.retrieve.mockReset();
  apiTestMocks.stripe.subscriptionSchedules.create.mockReset();
  apiTestMocks.stripe.subscriptionSchedules.update.mockReset();
  apiTestMocks.stripe.subscriptionSchedules.release.mockReset();
  apiTestMocks.stripe.webhooks.constructEvent.mockReset();
  apiTestMocks.stripe.checkout.sessions.create.mockReset();
  apiTestMocks.stripe.checkout.sessions.retrieve.mockReset();
  apiTestMocks.stripe.checkout.sessions.expire.mockReset();
  apiTestMocks.stripe.billingPortal.configurations.list.mockReset();
  apiTestMocks.stripe.billingPortal.configurations.create.mockReset();
  apiTestMocks.stripe.billingPortal.configurations.update.mockReset();
  apiTestMocks.stripe.billingPortal.sessions.create.mockReset();
  apiTestMocks.stripe.coupons.retrieve.mockReset();
  apiTestMocks.stripe.prices.retrieve.mockReset();
  apiTestMocks.stripe.prices.retrieve.mockImplementation(
    resolveDefaultStripePrice,
  );
  apiTestMocks.stripe.prices.create.mockReset();
  apiTestMocks.webpush.sendNotification.mockReset();
  apiTestMocks.webpush.sendNotification.mockResolvedValue(undefined);
  // Re-install the Stripe client override so getStripeClient() returns
  // the centralized mock surface (the vi.mock("stripe") factory above
  // doesn't compose with `new StripeSDK()` because vi.fn isn't a real
  // constructor; we route through the testOverride instead).
  mockStripeClient(apiTestMocks.stripe as unknown as StripeSDK);
  apiTestMocks.telegram.getMe.mockReset();
  apiTestMocks.telegram.getFile.mockReset();
  apiTestMocks.telegram.deleteWebhook.mockReset();
  apiTestMocks.telegram.deleteWebhook.mockResolvedValue(undefined);
  apiTestMocks.telegram.setWebhook.mockReset();
  apiTestMocks.telegram.setWebhook.mockResolvedValue(undefined);
  apiTestMocks.telegram.setMyCommands.mockReset();
  apiTestMocks.telegram.setMyCommands.mockResolvedValue(undefined);
  apiTestMocks.telegram.getUserProfilePhotos.mockReset();
  apiTestMocks.otel.registerOTel.mockReset();
  apiTestMocks.sentry.captureException.mockReset();
  apiTestMocks.sentry.httpIntegration.mockReset();
  apiTestMocks.sentry.init.mockReset();
  apiTestMocks.sentry.nativeNodeFetchIntegration.mockReset();
}
