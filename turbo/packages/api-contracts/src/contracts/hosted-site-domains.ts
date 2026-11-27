import { hostedSiteUrlSlugSchema } from "../validators/host";
import {
  array,
  boolean,
  iso,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { apiErrorSchema } from "./errors";
import { authHeadersSchema } from "./base";

export const HOSTED_DOMAIN_PROBE_HEADER = "X-Okou-Domain-Probe-Version";

export const hostedDomainCheckSchema = object({
  status: zEnum(["passed", "pending", "failed", "unavailable", "not_checked"]),
  message: string(),
});
export const hostedDomainRecordCheckSchema = object({
  type: zEnum(["TXT", "CNAME", "A", "AAAA"]),
  name: string(),
  value: string(),
  status: hostedDomainCheckSchema.shape.status,
  message: string(),
  observedValues: array(string()),
  checkedAt: iso.datetime(),
});
export const hostedDomainSetupSchema = object({
  providerName: string().nullable(),
  controlPanelUrl: string().nullable(),
  automaticUrl: string().nullable(),
  status: zEnum(["supported", "manual", "unavailable"]),
});
export const hostedDomainVerificationSchema = object({
  status: zEnum(["ready", "incomplete", "unavailable"]),
  eligibleForSelection: boolean().default(false),
  automatic: object({
    id: uuid(),
    expiresAt: iso.datetime(),
    status: zEnum(["checking", "timed_out"]),
  }).optional(),
  checkedAt: iso.datetime(),
  recordChecks: array(hostedDomainRecordCheckSchema),
  validationRecords: array(
    object({
      type: zEnum(["TXT", "CNAME", "A", "AAAA"]),
      name: string(),
      value: string(),
    }),
  ).default([]),
  checks: object({
    ownership: hostedDomainCheckSchema,
    dns: hostedDomainCheckSchema,
    provider: hostedDomainCheckSchema,
    certificate: hostedDomainCheckSchema,
    route: hostedDomainCheckSchema,
  }),
});
export type HostedDomainVerification = zInfer<
  typeof hostedDomainVerificationSchema
>;
export const hostedDomainSchema = object({
  id: uuid(),
  hostname: string(),
  revision: uuid(),
  ready: boolean(),
  removing: boolean(),
  records: array(
    object({
      type: zEnum(["TXT", "CNAME", "A", "AAAA"]),
      name: string(),
      value: string(),
    }),
  ),
  verification: hostedDomainVerificationSchema.nullable(),
});
export const hostedDomainSettingsSchema = object({
  siteId: uuid(),
  defaultUrl: string(),
  effectiveUrl: string(),
  selectedDomainId: uuid().nullable(),
  revision: uuid(),
  allowed: boolean(),
  domains: array(hostedDomainSchema),
});
const ownerResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  503: apiErrorSchema,
};
const siteParams = object({ siteId: uuid() });
const domainParams = object({ siteId: uuid(), domainId: uuid() });
// Included in hostContract so browser clients retain one canonical host API.
export function hostedSiteDomainRoutes() {
  return {
    siteDomains: {
      method: "GET",
      path: "/api/host/sites/:siteId/domains",
      pathParams: siteParams,
      headers: authHeadersSchema,
      responses: { 200: hostedDomainSettingsSchema, ...ownerResponses },
      summary: "Read an owned website's domain configurations",
    },
    addSiteDomain: {
      method: "POST",
      path: "/api/host/sites/:siteId/domains",
      pathParams: siteParams,
      headers: authHeadersSchema,
      body: object({ hostname: string().trim().min(1).max(1024) }),
      responses: { 200: hostedDomainSettingsSchema, ...ownerResponses },
      summary: "Create a custom hostname claim and DNS instructions",
    },
    verifySiteDomain: {
      method: "POST",
      path: "/api/host/sites/:siteId/domains/:domainId/verify",
      pathParams: domainParams,
      headers: authHeadersSchema,
      body: object({ expectedRevision: uuid() }),
      responses: { 200: hostedDomainSettingsSchema, ...ownerResponses },
      summary: "Verify a custom hostname once and return all check results",
    },
    siteDomainSetup: {
      method: "GET",
      path: "/api/host/sites/:siteId/domains/:domainId/setup",
      pathParams: domainParams,
      headers: authHeadersSchema,
      responses: { 200: hostedDomainSetupSchema, ...ownerResponses },
      summary:
        "Discover DNS setup options for an owned domain and Okou's template",
    },
    removeSiteDomain: {
      method: "DELETE",
      path: "/api/host/sites/:siteId/domains/:domainId",
      pathParams: domainParams,
      headers: authHeadersSchema,
      body: object({ expectedRevision: uuid() }),
      responses: { 200: hostedDomainSettingsSchema, ...ownerResponses },
      summary: "Revoke a domain binding and remove its provider configuration",
    },
    selectSiteDomain: {
      method: "PATCH",
      path: "/api/host/sites/:siteId/domain-selection",
      pathParams: siteParams,
      headers: authHeadersSchema,
      body: object({
        domainId: uuid().nullable(),
        expectedRevision: uuid(),
        publicSlug: hostedSiteUrlSlugSchema.optional(),
        expectedPublicSlug: string().optional(),
      }),
      responses: { 200: hostedDomainSettingsSchema, ...ownerResponses },
      summary:
        "Save the website's selected address without changing its platform slug",
    },
    resolveCustomDomain: {
      method: "GET",
      path: "/api/host/custom-domains/:hostname",
      pathParams: object({ hostname: string().max(253) }),
      responses: {
        200: object({
          siteId: uuid(),
          publicSlug: string(),
          revision: uuid(),
        }).nullable(),
      },
      summary: "Resolve an exact verified hostname to its current website",
    },
    customDomainProbe: {
      method: "GET",
      path: "/api/host/custom-domain-probes/:domainId",
      pathParams: object({ domainId: uuid() }),
      query: object({
        hostname: string().max(253),
        proof: string().length(64),
      }),
      responses: { 200: object({ proof: string().nullable() }) },
      summary:
        "Validate the fixed routing probe without serving website content",
    },
  } as const;
}
