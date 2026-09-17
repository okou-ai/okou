import { randomUUID } from "node:crypto";

import type StripeSDK from "stripe";
import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { bankingContract } from "@okouai/api-contracts/contracts/banking";
import {
  billingAutoRechargeContract,
  billingCheckoutContract,
  billingCreditCheckoutContract,
  billingDowngradeContract,
  billingInvoicesContract,
  billingPortalContract,
  billingRedeemCodeContract,
  billingRedeemContract,
  billingRestoreContract,
  billingStatusContract,
  type AutoRechargeConfig,
  type BillingInvoicesResponse,
  type BillingStatusResponse,
  type CreditCheckoutRequest,
  type RedeemCodeRequest,
  type RedeemRequest,
} from "@okouai/api-contracts/contracts/billing";
import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { imageIoGenerateContract } from "@okouai/api-contracts/contracts/image-io-generate";
import { mapsContract } from "@okouai/api-contracts/contracts/maps";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";
import {
  usageRecordContract,
  type UsageRecordRange,
} from "@okouai/api-contracts/contracts/usage-record";
import { videoIoGenerateContract } from "@okouai/api-contracts/contracts/video-io-generate";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoSpeechContract } from "@okouai/api-contracts/contracts/voice-io-speech";
import { voiceIoSttContract } from "@okouai/api-contracts/contracts/voice-io-stt";

import { mockEnv } from "../../../../lib/env";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import type { UsagePricingResolution } from "../../../context/usage-pricing-resolution";
import {
  mockListStripeInvoices,
  mockStripeClient,
} from "../../../external/stripe-client";
import { testUsageSettlementRoutes } from "../../test-usage-settlement";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
import { acquisitionAttributionRoutes } from "../../acquisition-attribution";
import { bankingRoutes } from "../../banking";
import { billingAutoRechargeRoutes } from "../../billing-auto-recharge";
import { billingCheckoutRoutes } from "../../billing-checkout";
import { billingCreditCheckoutRoutes } from "../../billing-credit-checkout";
import { billingDowngradeRoutes } from "../../billing-downgrade";
import { billingInvoicesRoutes } from "../../billing-invoices";
import { billingPortalRoutes } from "../../billing-portal";
import { billingRedeemRoutes } from "../../billing-redeem";
import { billingRedeemCodeRoutes } from "../../billing-redeem-code";
import { billingRestoreRoutes } from "../../billing-restore";
import { billingStatusRoutes } from "../../billing-status";
import { builtInGenerationRoutes } from "../../built-in-generation";
import { featureSwitchesRoutes } from "../../feature-switches";
import { imageIoGenerateRoutes } from "../../image-io-generate";
import { mapsRoutes } from "../../maps";
import { usageMembersRoutes } from "../../usage-members";
import { usageRecordRoutes } from "../../usage-record";
import { videoIoGenerateRoutes } from "../../video-io-generate";
import { voiceIoQuotaRoutes } from "../../voice-io-quota";
import { voiceIoSpeechRoutes } from "../../voice-io-speech";
import { voiceIoSttRoutes } from "../../voice-io-stt";

type ClerkOrgRole = "org:admin" | "org:member";

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly privateMetadata: Readonly<Record<string, unknown>>;
}

interface ClerkOrganizationMembership {
  readonly organization?: {
    readonly id: string;
  };
  readonly publicUserData?: {
    readonly userId: string;
  };
  readonly role: ClerkOrgRole;
  readonly createdAt: number;
}

interface StripeInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly created: number;
  readonly amount_paid: number;
  readonly status: string | null;
  readonly hosted_invoice_url: string | null;
  readonly invoice_pdf: string | null;
}

interface CheckoutBody {
  readonly tier: "pro" | "team";
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly trialDays?: 7;
}

interface PortalBody {
  readonly returnUrl: string;
}

interface AutoRechargeUpdateBody {
  readonly enabled: boolean;
  readonly threshold?: number;
  readonly amount?: number;
}

type CheckoutStatus = 200 | 400 | 401 | 403 | 500 | 503;
type BillingMutationStatus = 200 | 400 | 401 | 403 | 409 | 500 | 503;
type ImageIoStatus = 200 | 202 | 400 | 401 | 402 | 403 | 500 | 502 | 503;
type VideoIoStatus = 200 | 202 | 400 | 401 | 402 | 403 | 500 | 502 | 503 | 504;
type VoiceSpeechStatus = 200 | 400 | 401 | 402 | 403 | 500 | 502 | 503;
type MapsStatus = 200 | 400 | 401 | 402 | 403 | 502 | 503;
type OsmLayer = "roads" | "buildings" | "water" | "parks";
type OsmStyle = "standard" | "guide";

interface OsmAreaBody {
  readonly bbox?: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  readonly center?: {
    readonly lat: number;
    readonly lng: number;
  };
  readonly radiusMeters?: number;
  readonly layers?: readonly OsmLayer[];
}

interface OsmRenderBody extends OsmAreaBody {
  readonly width?: number;
  readonly height?: number;
  readonly style?: OsmStyle;
  readonly title?: string;
  readonly markers?: readonly {
    readonly lat: number;
    readonly lng: number;
    readonly label?: string;
  }[];
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function clerkRole(actor: ApiTestUser): ClerkOrgRole | undefined {
  return actor.orgRole;
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Actor",
    privateMetadata: {},
  };
}

function clerkOrganizationMemberships(
  actor: ApiTestUser,
): readonly ClerkOrganizationMembership[] {
  if (!actor.orgId) {
    return [];
  }

  return [
    {
      organization: { id: actor.orgId },
      publicUserData: { userId: actor.userId },
      role: actor.orgRole ?? "org:admin",
      createdAt: 1,
    },
  ];
}

function stripeInvoices(value: unknown): readonly StripeInvoice[] {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return [];
  }

  const { data } = value;
  if (!Array.isArray(data)) {
    return [];
  }

  return data.filter((invoice): invoice is StripeInvoice => {
    return (
      typeof invoice === "object" &&
      invoice !== null &&
      "id" in invoice &&
      "created" in invoice &&
      "amount_paid" in invoice &&
      typeof invoice.id === "string" &&
      typeof invoice.created === "number" &&
      typeof invoice.amount_paid === "number"
    );
  });
}

export function createBillingMediaApi(context: TestContext) {
  const routeMocks = createRouteMocks(context);
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mockListStripeInvoices(async (customerId, created) => {
    return stripeInvoices(
      await context.mocks.stripe.invoices.list({
        customer: customerId,
        limit: created ? 100 : 24,
        ...(created ? { created } : {}),
      }),
    );
  });

  function authenticate(actor: ApiTestUser | null): AuthHeaders {
    if (!actor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    routeMocks.clerk.session(actor.userId, actor.orgId, clerkRole(actor));
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUserProfile(actor)],
    });
    const memberships = clerkOrganizationMemberships(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: memberships,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: memberships,
      },
    );
    return authHeaders(actor);
  }

  function configureBillingPrices(): void {
    mockEnv("OKOU_PRICE_PRO", "price_bdd_pro");
    mockEnv("OKOU_PRICE_TEAM", "price_bdd_team");
    mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", "price_bdd_custom_credit_unit");
  }

  function configureCampaign(): void {
    mockEnv(
      "OKOU_ONE_TIME_CAMPAIGN",
      JSON.stringify({
        ZERO100: {
          priceId: "price_bdd_campaign",
          couponId: "coupon_bdd_campaign",
        },
      }),
    );
  }

  function configureMapsProvider(): void {
    mockEnv("OKOU_MAPS_GOOGLE_MAPS_TOKEN", "test-google-maps-key");
  }

  return {
    configureBillingPrices,
    configureCampaign,
    configureMapsProvider,

    async readBillingStatus(
      actor: ApiTestUser,
    ): Promise<BillingStatusResponse> {
      const client = setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      );
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async startCheckout(actor: ApiTestUser, body: CheckoutBody) {
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        [200],
      );
    },

    async requestCheckout(
      actor: ApiTestUser | null,
      body: CheckoutBody,
      statuses: readonly CheckoutStatus[],
    ) {
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async completeCheckout(
      actor: ApiTestUser,
      body: { readonly sessionId: string },
      statuses: readonly (200 | 400 | 401 | 403 | 500 | 503)[],
    ) {
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      );
      return await accept(
        client.complete({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async startCreditCheckout(actor: ApiTestUser, body: CreditCheckoutRequest) {
      const client = setupApp({
        context,
        routes: billingCreditCheckoutRoutes,
      })(billingCreditCheckoutContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        [200],
      );
    },

    async requestCreditCheckout(
      actor: ApiTestUser,
      body: CreditCheckoutRequest,
      statuses: readonly CheckoutStatus[],
    ) {
      const client = setupApp({
        context,
        routes: billingCreditCheckoutRoutes,
      })(billingCreditCheckoutContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async openPortal(actor: ApiTestUser, body: PortalBody) {
      const client = setupApp({ context, routes: billingPortalRoutes })(
        billingPortalContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        [200],
      );
    },

    async readAutoRecharge(actor: ApiTestUser): Promise<AutoRechargeConfig> {
      const client = setupApp({
        context,
        routes: billingAutoRechargeRoutes,
      })(billingAutoRechargeContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async updateAutoRecharge(
      actor: ApiTestUser,
      body: AutoRechargeUpdateBody,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({
        context,
        routes: billingAutoRechargeRoutes,
      })(billingAutoRechargeContract);
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readInvoices(actor: ApiTestUser): Promise<BillingInvoicesResponse> {
      const client = setupApp({ context, routes: billingInvoicesRoutes })(
        billingInvoicesContract,
      );
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestInvoices(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context, routes: billingInvoicesRoutes })(
        billingInvoicesContract,
      );
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async downgradeBilling(
      actor: ApiTestUser,
      body: {
        readonly targetTier: "limited-free-1" | "pro-suspend" | "pro";
        readonly returnUrl?: string;
      },
      statuses: readonly BillingMutationStatus[],
    ) {
      const client = setupApp({ context, routes: billingDowngradeRoutes })(
        billingDowngradeContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async restoreBilling(
      actor: ApiTestUser,
      body: { readonly returnUrl?: string },
      statuses: readonly (200 | 401 | 403 | 409 | 500 | 503)[],
    ) {
      const client = setupApp({ context, routes: billingRestoreRoutes })(
        billingRestoreContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async redeemCampaign(
      actor: ApiTestUser,
      campaign: string,
      body: RedeemRequest,
    ) {
      const client = setupApp({ context, routes: billingRedeemRoutes })(
        billingRedeemContract,
      );
      return await accept(
        client.create({
          params: { campaign },
          headers: authenticate(actor),
          body,
        }),
        [200],
      );
    },

    async redeemCode(
      actor: ApiTestUser,
      body: RedeemCodeRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 500 | 503)[],
    ) {
      const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
        billingRedeemCodeContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readUsageMembers(
      actor: ApiTestUser,
      query: {
        readonly range?: UsageRecordRange;
        readonly tz?: string;
      } = {},
    ) {
      const client = setupApp({ context, routes: usageMembersRoutes })(
        usageMembersContract,
      );
      return await accept(
        client.get({ headers: authenticate(actor), query }),
        [200],
      );
    },

    async requestUsageMembers(
      actor: ApiTestUser,
      query: {
        readonly range?: UsageRecordRange;
        readonly tz?: string;
      },
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context, routes: usageMembersRoutes })(
        usageMembersContract,
      );
      return await accept(
        client.get({ headers: authenticate(actor), query }),
        statuses,
      );
    },

    async readUsageRecord(actor: ApiTestUser) {
      const client = setupApp({ context, routes: usageRecordRoutes })(
        usageRecordContract,
      );
      return await accept(
        client.get({
          headers: authenticate(actor),
          query: {
            page: 1,
            pageSize: 20,
            scope: "mine",
            range: "24h",
            tz: "UTC",
          },
        }),
        [200],
      );
    },

    async processOrgUsageEvents(
      actor: ApiTestUser,
      usagePricingResolution?: UsagePricingResolution,
    ) {
      if (!actor.orgId) {
        throw new Error("Cannot process usage without an organization");
      }
      const client = setupApp({
        context,
        routes: testUsageSettlementRoutes,
        usagePricingResolution,
      })(testUsageSettlementContract);
      return await accept(
        client.process({ body: { org_id: actor.orgId } }),
        [200],
      );
    },

    async recordSignupAttribution(actor: ApiTestUser) {
      const client = setupApp({
        context,
        routes: acquisitionAttributionRoutes,
      })(acquisitionAttributionContract);
      return await accept(
        client.recordSignup({
          headers: authenticate(actor),
          body: {
            attribution: {
              source_type: "paid",
              landing_host: "www.okou.ai",
              landing_path: "/",
              utm_source: "bdd",
            },
          },
        }),
        [200],
      );
    },

    async updateFeatureSwitches(
      actor: ApiTestUser,
      switches: Readonly<Record<string, boolean>>,
    ) {
      const client = setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      );
      return await accept(
        client.update({
          headers: authenticate(actor),
          body: { switches },
        }),
        [200],
      );
    },

    async readVoiceQuota(actor: ApiTestUser) {
      const client = setupApp({ context, routes: voiceIoQuotaRoutes })(
        voiceIoQuotaContract,
      );
      return await accept(client.get({ headers: authenticate(actor) }), [200]);
    },

    async requestVoiceStt(
      actor: ApiTestUser | null,
      formData: FormData,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 429 | 500)[],
    ) {
      const client = setupApp({ context, routes: voiceIoSttRoutes })(
        voiceIoSttContract,
      );
      return await accept(
        client.post({ headers: authenticate(actor), body: formData }),
        statuses,
      );
    },

    async requestVoiceSpeech(
      actor: ApiTestUser | null,
      body: {
        readonly text?: string;
        readonly voice?: string;
        readonly instructions?: string;
      },
      statuses: readonly VoiceSpeechStatus[],
    ) {
      const client = setupApp({ context, routes: voiceIoSpeechRoutes })(
        voiceIoSpeechContract,
      );
      return await accept(
        client.post({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestImageIoGenerate(
      actor: ApiTestUser | null,
      body: {
        readonly prompt?: string;
        readonly model?: string;
        readonly size?: string;
        readonly quality?: string;
        readonly background?: string;
        readonly outputFormat?: string;
        readonly outputCompression?: number;
        readonly moderation?: string;
        readonly seed?: number;
        readonly safetyTolerance?: string;
        readonly enhancePrompt?: boolean;
        readonly imageUrl?: string;
        readonly imageUrls?: readonly string[];
        readonly maskImageUrl?: string;
        readonly inputFidelity?: string;
        readonly imagePromptStrength?: number;
      },
      statuses: readonly ImageIoStatus[],
    ) {
      const client = setupApp({ context, routes: imageIoGenerateRoutes })(
        imageIoGenerateContract,
      );
      return await accept(
        client.post({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestVideoIoGenerate(
      actor: ApiTestUser | null,
      body: {
        readonly prompt?: string;
        readonly model?: string;
        readonly aspectRatio?: string;
        readonly duration?: string;
        readonly resolution?: string;
        readonly generateAudio?: boolean;
        readonly negativePrompt?: string;
        readonly seed?: number;
        readonly autoFix?: boolean;
        readonly safetyTolerance?: string;
        readonly imageUrls?: readonly string[];
        readonly videoUrls?: readonly string[];
        readonly audioUrls?: readonly string[];
        readonly firstFrameImageUrl?: string;
        readonly lastFrameImageUrl?: string;
      },
      statuses: readonly VideoIoStatus[],
    ) {
      const client = setupApp({ context, routes: videoIoGenerateRoutes })(
        videoIoGenerateContract,
      );
      return await accept(
        client.post({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readBuiltInGeneration(
      actor: ApiTestUser,
      generationId = randomUUID(),
      statuses: readonly (200 | 401 | 403 | 404 | 500)[] = [200],
    ) {
      const client = setupApp({ context, routes: builtInGenerationRoutes })(
        builtInGenerationContract,
      );
      return await accept(
        client.get({
          params: { generationId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async requestMapsGeocode(
      actor: ApiTestUser | null,
      body: { readonly address: string; readonly region?: string },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: mapsRoutes })(mapsContract);
      return await accept(
        client.geocode({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsReverseGeocode(
      actor: ApiTestUser | null,
      body: { readonly lat: number; readonly lng: number },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: mapsRoutes })(mapsContract);
      return await accept(
        client.reverseGeocode({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsDirections(
      actor: ApiTestUser | null,
      body: {
        readonly origin: string;
        readonly destination: string;
        readonly mode?: "driving" | "walking" | "bicycling" | "transit";
        readonly departureTime?: string;
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: mapsRoutes })(mapsContract);
      return await accept(
        client.directions({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsPlacesSearch(
      actor: ApiTestUser | null,
      body: {
        readonly query: string;
        readonly location?: string;
        readonly radius?: number;
        readonly limit?: number;
        readonly region?: string;
        readonly fields?: "pro" | "enterprise";
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: mapsRoutes })(mapsContract);
      return await accept(
        client.placesSearch({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsPlacesDetails(
      actor: ApiTestUser | null,
      body: {
        readonly placeId: string;
        readonly fields?: "essentials" | "pro" | "enterprise";
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: mapsRoutes })(mapsContract);
      return await accept(
        client.placesDetails({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsOsmDownload(
      actor: ApiTestUser | null,
      body: OsmAreaBody,
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: mapsRoutes })(mapsContract);
      return await accept(
        client.osmDownload({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestMapsOsmRender(
      actor: ApiTestUser | null,
      body: OsmRenderBody,
      statuses: readonly MapsStatus[],
    ) {
      const client = setupApp({ context, routes: mapsRoutes })(mapsContract);
      return await accept(
        client.osmRender({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestBankingAccounts(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 400 | 401 | 403 | 502 | 503)[],
    ) {
      const client = setupApp({ context, routes: bankingRoutes })(
        bankingContract,
      );
      return await accept(
        client.accounts({ headers: authenticate(actor), body: {} }),
        statuses,
      );
    },
  };
}
