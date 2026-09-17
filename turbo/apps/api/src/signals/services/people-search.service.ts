import {
  PEOPLE_SEARCH_MAX_COMPANY_CHARS,
  PEOPLE_SEARCH_MAX_LIMIT,
  PEOPLE_SEARCH_MAX_LOCATION_CHARS,
  PEOPLE_SEARCH_MAX_NAME_CHARS,
  PEOPLE_SEARCH_MAX_SOURCE_TITLE_CHARS,
  PEOPLE_SEARCH_MAX_SOURCE_URL_CHARS,
  PEOPLE_SEARCH_MAX_SOURCES,
  PEOPLE_SEARCH_MAX_SUMMARY_CHARS,
  PEOPLE_SEARCH_MAX_TITLE_CHARS,
  type PeopleSearchProfile,
  type PeopleSearchRequest,
  type PeopleSearchResponse,
  type PeopleSearchSource,
} from "@okouai/api-contracts/contracts/people-search";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import {
  readBoundedResponseText,
  safeJsonParse,
  safeUrlParse,
  settle,
} from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const PROVIDER = "perplexity";
const USAGE_KIND = "people-search";
const BILLING_CATEGORY = "request";
const PERPLEXITY_AGENT_URL = "https://api.perplexity.ai/v1/agent";
const PERPLEXITY_MODEL = "openai/gpt-5-mini";
const PERPLEXITY_TIMEOUT_MS = 45_000;
const MAX_PERPLEXITY_RESPONSE_BYTES = 512 * 1024;
const MAX_PERPLEXITY_ERROR_MESSAGE_CHARS = 4096;
const MAX_TOTAL_PROFILE_TEXT_CHARS = 64_000;

const structuredProfileSchema = z
  .object({
    name: z.string().min(1).max(PEOPLE_SEARCH_MAX_NAME_CHARS),
    title: z.string().max(PEOPLE_SEARCH_MAX_TITLE_CHARS).nullable(),
    company: z.string().max(PEOPLE_SEARCH_MAX_COMPANY_CHARS).nullable(),
    location: z.string().max(PEOPLE_SEARCH_MAX_LOCATION_CHARS).nullable(),
    summary: z.string().max(PEOPLE_SEARCH_MAX_SUMMARY_CHARS).nullable(),
    sourceIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(PEOPLE_SEARCH_MAX_SOURCES)
      .refine((ids) => {
        return new Set(ids).size === ids.length;
      }),
  })
  .strict();

const structuredResponseSchema = z
  .object({
    profiles: z.array(structuredProfileSchema).max(PEOPLE_SEARCH_MAX_LIMIT),
  })
  .strict();

const perplexityResultSchema = z.object({
  id: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
});

const peopleSearchOutputItemSchema = z.object({
  type: z.literal("people_search_results"),
  results: z.array(perplexityResultSchema),
});

const messageOutputItemSchema = z.object({
  type: z.literal("message"),
  role: z.string(),
  content: z.array(z.unknown()),
});

const outputTextSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
});

const perplexityUsageSchema = z
  .object({
    tool_calls_details: z
      .object({
        search_people: z
          .object({
            invocation: z.literal(1).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const perplexityEnvelopeSchema = z.object({
  status: z.string(),
  output: z.array(z.unknown()),
  usage: perplexityUsageSchema.optional(),
});

const PEOPLE_SEARCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    profiles: {
      type: "array",
      maxItems: PEOPLE_SEARCH_MAX_LIMIT,
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: PEOPLE_SEARCH_MAX_NAME_CHARS,
          },
          title: {
            anyOf: [
              {
                type: "string",
                maxLength: PEOPLE_SEARCH_MAX_TITLE_CHARS,
              },
              { type: "null" },
            ],
          },
          company: {
            anyOf: [
              {
                type: "string",
                maxLength: PEOPLE_SEARCH_MAX_COMPANY_CHARS,
              },
              { type: "null" },
            ],
          },
          location: {
            anyOf: [
              {
                type: "string",
                maxLength: PEOPLE_SEARCH_MAX_LOCATION_CHARS,
              },
              { type: "null" },
            ],
          },
          summary: {
            anyOf: [
              {
                type: "string",
                maxLength: PEOPLE_SEARCH_MAX_SUMMARY_CHARS,
              },
              { type: "null" },
            ],
          },
          sourceIds: {
            // Perplexity rejects JSON Schema uniqueItems; the service enforces
            // uniqueness after generation with structuredProfileSchema.
            type: "array",
            minItems: 1,
            maxItems: PEOPLE_SEARCH_MAX_SOURCES,
            items: { type: "integer", minimum: 1 },
          },
        },
        required: [
          "name",
          "title",
          "company",
          "location",
          "summary",
          "sourceIds",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["profiles"],
  additionalProperties: false,
} as const;

type ErrorStatus = 502 | 503;

interface PeopleSearchErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface PeopleSearchErrorResult {
  readonly kind: "error";
  readonly error: PeopleSearchErrorResponse;
}

type PerplexityBodyResult =
  | PeopleSearchErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type PerplexityResponseResult =
  | PeopleSearchErrorResult
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly body: unknown;
    };

interface AuthedPeopleSearchArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: PeopleSearchRequest;
}

interface CompletePeopleSearchArgs {
  readonly apiKey: string;
  readonly request: PeopleSearchRequest;
  readonly recordUsage: () => Promise<number>;
}

type NormalizedProfilesResult =
  | { readonly kind: "profiles"; readonly profiles: PeopleSearchProfile[] }
  | PeopleSearchErrorResult;

type PeopleSearchCommandResponse =
  | { readonly status: 200; readonly body: PeopleSearchResponse }
  | PeopleSearchErrorResponse
  | ManagedUsageErrorResponse;

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(
  message: string,
  code = "PERPLEXITY_ERROR",
): PeopleSearchErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

function invalidResponse(): PeopleSearchErrorResponse {
  return badGateway(
    "Perplexity people search returned an invalid response",
    "PERPLEXITY_INVALID_RESPONSE",
  );
}

function serviceUnavailable(
  message: string,
  code: string,
): PeopleSearchErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

function errorResult(
  error: PeopleSearchErrorResponse,
): PeopleSearchErrorResult {
  return { kind: "error", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlCharacter(character: string): boolean {
  const codeUnit = character.charCodeAt(0);
  return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f);
}

function sanitizeProviderText(value: string): string {
  return Array.from(value, (character) => {
    return isControlCharacter(character) ? " " : character;
  }).join("");
}

function truncateAtCharacterBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const finalCodeUnit = value.charCodeAt(maxChars - 1);
  const endsWithHighSurrogate =
    finalCodeUnit >= 0xd8_00 && finalCodeUnit <= 0xdb_ff;
  return value.slice(0, endsWithHighSurrogate ? maxChars - 1 : maxChars);
}

function boundedErrorMessage(message: string): string {
  const sanitized = sanitizeProviderText(message);
  return sanitized.length <= MAX_PERPLEXITY_ERROR_MESSAGE_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_PERPLEXITY_ERROR_MESSAGE_CHARS - 3)}...`;
}

function perplexityErrorMessage(body: unknown): string {
  if (isRecord(body)) {
    for (const key of ["error", "message", "detail"]) {
      const value = body[key];
      if (typeof value === "string") {
        return boundedErrorMessage(value);
      }
    }
    const providerError = body.error;
    if (isRecord(providerError) && typeof providerError.message === "string") {
      return boundedErrorMessage(providerError.message);
    }
  }
  if (typeof body === "string" && body.trim()) {
    return boundedErrorMessage(body);
  }
  return "Perplexity people search request failed";
}

function parseResponseText(text: string): unknown {
  if (!text) {
    return null;
  }
  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

function providerRequestBody(request: PeopleSearchRequest) {
  return {
    model: PERPLEXITY_MODEL,
    reasoning: { effort: "low" },
    tools: [
      {
        type: "people_search",
      },
    ],
    max_steps: 2,
    max_output_tokens: 4000,
    store: false,
    input: request.query,
    instructions: [
      "Use exactly one people_search tool call for public professional research.",
      `Return at most ${request.limit} profiles.`,
      "Extract concise profile fields from the tool results.",
      "Keep extracted fields limited to public professional information; do not return email addresses, phone numbers, home addresses, or other personal contact details.",
      "Use only distinct positive integer result IDs from people_search_results in sourceIds.",
      "Do not include URLs in the structured output.",
    ].join(" "),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "PeopleSearchProfiles",
        schema: PEOPLE_SEARCH_JSON_SCHEMA,
      },
    },
  };
}

async function fetchPerplexityPeopleSearch(
  apiKey: string,
  request: PeopleSearchRequest,
  signal: AbortSignal,
): Promise<PerplexityBodyResult> {
  const settled = await settle(
    (async (): Promise<PerplexityResponseResult> => {
      const response = await fetch(PERPLEXITY_AGENT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(providerRequestBody(request)),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(PERPLEXITY_TIMEOUT_MS),
        ]),
      });
      const textResult = await readBoundedResponseText(
        response,
        MAX_PERPLEXITY_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        return errorResult(
          badGateway(
            "Perplexity people search response is too large",
            "PEOPLE_SEARCH_OUTPUT_TOO_LARGE",
          ),
        );
      }
      return {
        kind: "response",
        response,
        body: parseResponseText(textResult.text),
      };
    })(),
  );

  if (!settled.ok) {
    const { error } = settled;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      return errorResult(
        badGateway(
          "Perplexity people search request timed out",
          "PEOPLE_SEARCH_TIMEOUT",
        ),
      );
    }
    return errorResult(badGateway("Perplexity people search request failed"));
  }
  if (settled.value.kind === "error") {
    return settled.value;
  }

  const { response, body } = settled.value;
  if (!response.ok) {
    return errorResult(
      response.status === 429
        ? badGateway(
            "Perplexity people search is temporarily rate limited",
            "PERPLEXITY_RATE_LIMITED",
          )
        : badGateway(perplexityErrorMessage(body)),
    );
  }
  return { kind: "body", body };
}

function outputItemsByType(
  output: readonly unknown[],
  type: string,
): readonly unknown[] {
  return output.filter((item) => {
    return isRecord(item) && item.type === type;
  });
}

function structuredOutputText(output: readonly unknown[]): string | undefined {
  const textItems: string[] = [];
  for (const item of outputItemsByType(output, "message")) {
    const message = messageOutputItemSchema.safeParse(item);
    if (!message.success) {
      return undefined;
    }
    if (message.data.role !== "assistant") {
      continue;
    }
    for (const content of outputItemsByType(
      message.data.content,
      "output_text",
    )) {
      const outputText = outputTextSchema.safeParse(content);
      if (!outputText.success) {
        return undefined;
      }
      textItems.push(outputText.data.text);
    }
  }
  return textItems.length === 1 ? textItems[0] : undefined;
}

function normalizedHttpUrl(value: string): string | undefined {
  if (value.length > PEOPLE_SEARCH_MAX_SOURCE_URL_CHARS) {
    return undefined;
  }
  for (const character of value) {
    if (isControlCharacter(character)) {
      return undefined;
    }
  }
  const url = safeUrlParse(value);
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    return undefined;
  }
  const normalized = url.toString();
  return normalized.length <= PEOPLE_SEARCH_MAX_SOURCE_URL_CHARS
    ? normalized
    : undefined;
}

function normalizedOptionalText(
  value: string | null,
  maxChars: number,
): string | undefined {
  if (value === null) {
    return undefined;
  }
  const normalized = truncateAtCharacterBoundary(
    sanitizeProviderText(value),
    maxChars,
  ).trim();
  return normalized || undefined;
}

function normalizedSource(
  result: z.infer<typeof perplexityResultSchema>,
): PeopleSearchSource | undefined {
  const url = normalizedHttpUrl(result.url);
  if (!url) {
    return undefined;
  }
  return {
    title: truncateAtCharacterBoundary(
      sanitizeProviderText(result.title),
      PEOPLE_SEARCH_MAX_SOURCE_TITLE_CHARS,
    ).trim(),
    url,
  };
}

function normalizedProfile(
  profile: z.infer<typeof structuredProfileSchema>,
  resultsById: ReadonlyMap<number, z.infer<typeof perplexityResultSchema>>,
): PeopleSearchProfile | undefined {
  const name = truncateAtCharacterBoundary(
    sanitizeProviderText(profile.name),
    PEOPLE_SEARCH_MAX_NAME_CHARS,
  ).trim();
  if (!name) {
    return undefined;
  }
  const sources: PeopleSearchSource[] = [];
  const sourceUrls = new Set<string>();
  for (const sourceId of profile.sourceIds) {
    const result = resultsById.get(sourceId);
    const source = result ? normalizedSource(result) : undefined;
    if (!source) {
      return undefined;
    }
    if (!sourceUrls.has(source.url)) {
      sourceUrls.add(source.url);
      sources.push(source);
    }
  }
  const title = normalizedOptionalText(
    profile.title,
    PEOPLE_SEARCH_MAX_TITLE_CHARS,
  );
  const company = normalizedOptionalText(
    profile.company,
    PEOPLE_SEARCH_MAX_COMPANY_CHARS,
  );
  const location = normalizedOptionalText(
    profile.location,
    PEOPLE_SEARCH_MAX_LOCATION_CHARS,
  );
  const summary = normalizedOptionalText(
    profile.summary,
    PEOPLE_SEARCH_MAX_SUMMARY_CHARS,
  );
  return {
    name,
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    ...(location ? { location } : {}),
    ...(summary ? { summary } : {}),
    sources,
  };
}

function profileIdentityKey(profile: PeopleSearchProfile): string {
  return JSON.stringify([
    profile.name,
    profile.sources
      .map((source) => {
        return source.url;
      })
      .sort(),
  ]);
}

function profileTextCharacters(profile: PeopleSearchProfile): number {
  return (
    profile.name.length +
    (profile.title?.length ?? 0) +
    (profile.company?.length ?? 0) +
    (profile.location?.length ?? 0) +
    (profile.summary?.length ?? 0) +
    profile.sources.reduce((total, source) => {
      return total + source.title.length + source.url.length;
    }, 0)
  );
}

function normalizeProfiles(
  request: PeopleSearchRequest,
  body: unknown,
): NormalizedProfilesResult {
  const envelope = perplexityEnvelopeSchema.safeParse(body);
  if (!envelope.success || envelope.data.status !== "completed") {
    return errorResult(invalidResponse());
  }
  const peopleItems = outputItemsByType(
    envelope.data.output,
    "people_search_results",
  );
  const peopleItem =
    peopleItems.length === 1
      ? peopleSearchOutputItemSchema.safeParse(peopleItems[0])
      : undefined;
  const outputText = structuredOutputText(envelope.data.output);
  if (!peopleItem?.success || outputText === undefined) {
    return errorResult(invalidResponse());
  }
  const structured = structuredResponseSchema.safeParse(
    safeJsonParse(outputText),
  );
  if (!structured.success || structured.data.profiles.length > request.limit) {
    return errorResult(invalidResponse());
  }

  const resultsById = new Map<number, z.infer<typeof perplexityResultSchema>>();
  for (const result of peopleItem.data.results) {
    if (resultsById.has(result.id)) {
      return errorResult(invalidResponse());
    }
    resultsById.set(result.id, result);
  }

  const profiles: PeopleSearchProfile[] = [];
  const profileKeys = new Set<string>();
  let totalCharacters = 0;
  for (const profile of structured.data.profiles) {
    const normalized = normalizedProfile(profile, resultsById);
    if (!normalized) {
      return errorResult(invalidResponse());
    }
    const profileKey = profileIdentityKey(normalized);
    if (profileKeys.has(profileKey)) {
      continue;
    }
    totalCharacters += profileTextCharacters(normalized);
    if (totalCharacters > MAX_TOTAL_PROFILE_TEXT_CHARS) {
      return errorResult(
        badGateway(
          "Perplexity people search output exceeds the supported text limit",
          "PEOPLE_SEARCH_OUTPUT_TOO_LARGE",
        ),
      );
    }
    profileKeys.add(profileKey);
    profiles.push(normalized);
  }
  return { kind: "profiles", profiles };
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function successBody(
  request: PeopleSearchRequest,
  profiles: readonly PeopleSearchProfile[],
  creditsCharged: number,
): PeopleSearchResponse {
  return {
    query: request.query,
    limit: request.limit,
    provider: PROVIDER,
    billingCategory: BILLING_CATEGORY,
    billingQuantity: 1,
    creditsCharged,
    profiles: [...profiles],
  };
}

async function completePeopleSearch(
  args: CompletePeopleSearchArgs,
  providerSignal: AbortSignal,
): Promise<PeopleSearchCommandResponse> {
  const providerResult = await fetchPerplexityPeopleSearch(
    args.apiKey,
    args.request,
    providerSignal,
  );
  if (providerResult.kind === "error") {
    return providerResult.error;
  }
  const normalized = normalizeProfiles(args.request, providerResult.body);
  if (normalized.kind === "error") {
    return normalized.error;
  }
  const creditsCharged = await args.recordUsage();
  return {
    status: 200,
    body: successBody(args.request, normalized.profiles, creditsCharged),
  };
}

export const peopleSearch$ = command(
  async (
    { get, set },
    args: AuthedPeopleSearchArgs,
    signal: AbortSignal,
  ): Promise<PeopleSearchCommandResponse> => {
    const apiKey = env("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou People Search Perplexity provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category: BILLING_CATEGORY,
        },
        label: "Okou People Search",
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const runId = runIdForUsage(args.auth);
    return completePeopleSearch(
      {
        apiKey,
        request: args.body,
        recordUsage: () => {
          // Provider work has completed, so client disconnect must not skip billing.
          return set(
            recordManagedUsage$,
            {
              actor: {
                orgId: args.auth.orgId,
                userId: args.auth.userId,
                ...(runId ? { runId } : {}),
              },
              resource: {
                kind: USAGE_KIND,
                provider: PROVIDER,
                category: BILLING_CATEGORY,
              },
              label: "people search",
            },
            signal,
          );
        },
      },
      requestSignal,
    );
  },
);
