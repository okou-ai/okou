import { Readable } from "node:stream";
import {
  hostContract,
  type HostedSiteCompleteResponse,
  type HostedSiteDeploymentsResponse,
  type HostedSiteFilesResponse,
  type HostedSitePrepareRequest,
  type HostedSitePrepareResponse,
} from "@okouai/api-contracts/contracts/host";
import { mapsContract } from "@okouai/api-contracts/contracts/maps";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import type { RouteEntry } from "../../../route-entry";
import { hostRoutes } from "../../host";
import { mapsRoutes } from "../../maps";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

/**
 * Host routes accept both browser sessions and Okou run tokens, so the
 * host helpers take either a Clerk-backed test user or a raw bearer token.
 */
interface BearerActor {
  readonly bearerToken: string;
}

type HostActor = ApiTestUser | BearerActor;

type HostPrepareStatus = 200 | 400 | 401 | 402 | 403 | 409 | 500;
type HostCompleteStatus = 200 | 400 | 401 | 402 | 403 | 404 | 409 | 500;
type HostFilesStatus = 200 | 400 | 401 | 403 | 404 | 409 | 500;
type HostDeploymentsStatus = 200 | 400 | 401 | 403 | 404 | 500;
type MapsStatus = 200 | 400 | 401 | 402 | 403 | 502 | 503;

interface HostedSitesS3Capture {
  readonly puts: { readonly key: string; readonly body: string }[];
  readonly copies: { readonly key: string; readonly copySource: string }[];
  readonly missingKeys: Set<string>;
}

function isBearerActor(actor: HostActor): actor is BearerActor {
  return "bearerToken" in actor;
}

function authenticate(
  context: TestContext,
  actor: HostActor | null,
): AuthHeaders {
  if (actor && isBearerActor(actor)) {
    return { authorization: `Bearer ${actor.bearerToken}` };
  }
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function bodyText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function notFoundS3Error(key: string): Error {
  const error = new Error(`Not found: ${key}`) as Error & {
    $metadata: { httpStatusCode: number };
  };
  error.name = "NotFound";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

const hostMapsRoutes: readonly RouteEntry[] = [...hostRoutes, ...mapsRoutes];

export function createHostMapsBddApi(context: TestContext) {
  function hostClient() {
    return setupAppWithRoutes({
      context,
      routes: hostMapsRoutes,
      baseUrl: "https://api.okou.ai",
    })(hostContract);
  }

  function mapsClient() {
    return setupAppWithRoutes({
      context,
      routes: hostMapsRoutes,
    })(mapsContract);
  }

  return {
    async requestPrivateHostedPreview(
      actor: HostActor | null,
      deploymentId: string,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        hostClient().privatePreview({
          headers: authenticate(context, actor),
          params: { deploymentId },
        }),
        statuses,
      );
    },

    async requestPrivateHostedView(
      actor: HostActor | null,
      deploymentId: string,
      statuses: readonly (302 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        hostClient().privateView({
          headers: authenticate(context, actor),
          params: { deploymentId },
        }),
        statuses,
      );
    },

    /**
     * Install an explicit hosted-sites S3 boundary: presigned upload URLs
     * resolve, HeadObject reports every key uploaded except `missingKeys`,
     * and Put/Copy commands are recorded for boundary-contract assertions.
     * Context mocks are reset in the global afterEach, so no teardown is
     * needed.
     */
    captureHostedSitesS3(): HostedSitesS3Capture {
      const capture: HostedSitesS3Capture = {
        puts: [],
        copies: [],
        missingKeys: new Set<string>(),
      };
      const objects = new Map<string, string>();
      context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
        const input = commandInput(command);
        if (
          commandName(command) === "PutObjectCommand" &&
          typeof input.Key === "string"
        ) {
          objects.set(input.Key, "Hosted fixture");
        }
        return Promise.resolve(
          "https://r2.example.com/hosted-sites/upload?sig=bdd",
        );
      });
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const name = commandName(command);
        const input = commandInput(command);
        const key = typeof input.Key === "string" ? input.Key : "";
        if (name === "HeadObjectCommand" && capture.missingKeys.has(key)) {
          return Promise.reject(notFoundS3Error(key));
        }
        if (name === "GetObjectCommand") {
          if (capture.missingKeys.has(key)) {
            return Promise.reject(notFoundS3Error(key));
          }
          const body =
            objects.get(key) ??
            ((key.startsWith("private-sites/") || key.startsWith("sites/")) &&
            !/\/(?:manifest|active)\.json$/u.test(key)
              ? "Hosted fixture"
              : undefined);
          if (body === undefined) {
            return Promise.reject(notFoundS3Error(key));
          }
          return Promise.resolve({
            Body: Readable.from([Buffer.from(body)]),
            ETag: '"hosted-fixture"',
            ContentLength: Buffer.byteLength(body),
          });
        }
        if (name === "PutObjectCommand") {
          const body = bodyText(input.Body);
          objects.set(key, body);
          capture.puts.push({ key, body });
        }
        if (name === "CopyObjectCommand") {
          capture.copies.push({
            key,
            copySource:
              typeof input.CopySource === "string" ? input.CopySource : "",
          });
        }
        return Promise.resolve({});
      });
      return capture;
    },

    async prepareHostedSite(
      actor: HostActor,
      body: HostedSitePrepareRequest,
    ): Promise<HostedSitePrepareResponse> {
      const response = await accept(
        hostClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestPrepareHostedSite(
      actor: HostActor | null,
      body: HostedSitePrepareRequest,
      statuses: readonly HostPrepareStatus[],
    ) {
      return await accept(
        hostClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async completeHostedSite(
      actor: HostActor,
      deploymentId: string,
    ): Promise<HostedSiteCompleteResponse> {
      const response = await accept(
        hostClient().complete({
          headers: authenticate(context, actor),
          params: { deploymentId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestCompleteHostedSite(
      actor: HostActor | null,
      deploymentId: string,
      statuses: readonly HostCompleteStatus[],
    ) {
      return await accept(
        hostClient().complete({
          headers: authenticate(context, actor),
          params: { deploymentId },
          body: {},
        }),
        statuses,
      );
    },

    async readHostedSiteFiles(
      actor: ApiTestUser,
      publicSlug: string,
      version?: number,
    ): Promise<HostedSiteFilesResponse> {
      const response = await accept(
        hostClient().files({
          headers: authenticate(context, actor),
          params: { publicSlug },
          query: version === undefined ? {} : { version },
        }),
        [200],
      );
      return response.body;
    },

    async requestHostedSiteFiles(
      actor: ApiTestUser | null,
      publicSlug: string,
      statuses: readonly HostFilesStatus[],
      version?: number,
    ) {
      return await accept(
        hostClient().files({
          headers: authenticate(context, actor),
          params: { publicSlug },
          query: version === undefined ? {} : { version },
        }),
        statuses,
      );
    },

    async readHostedSiteDeployments(
      actor: ApiTestUser,
      site: string,
    ): Promise<HostedSiteDeploymentsResponse> {
      const response = await accept(
        hostClient().deployments({
          headers: authenticate(context, actor),
          params: { site },
        }),
        [200],
      );
      return response.body;
    },

    async requestHostedSiteDeployments(
      actor: ApiTestUser | null,
      site: string,
      statuses: readonly HostDeploymentsStatus[],
    ) {
      return await accept(
        hostClient().deployments({
          headers: authenticate(context, actor),
          params: { site },
        }),
        statuses,
      );
    },

    async requestMapsGeocodeWithBearer(
      token: string,
      body: { readonly address: string; readonly region?: string },
      statuses: readonly MapsStatus[],
    ) {
      return await accept(
        mapsClient().geocode({
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
        statuses,
      );
    },
  };
}
