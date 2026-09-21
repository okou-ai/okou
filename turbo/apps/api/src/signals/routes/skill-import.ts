import {
  normalizeSkillImportName,
  SKILL_IMPORT_BINARY_CODE,
  SKILL_IMPORT_LIMITS,
  SKILL_IMPORT_NAME_TAKEN_CODE,
  SKILL_IMPORT_SESSION_INVALID_CODE,
  SKILL_IMPORT_SESSION_LIMIT_CODE,
  SKILL_IMPORT_TOO_LARGE_CODE,
  skillImportSessionsContract,
  skillImportSkillsContract,
  type SkillImportRequest,
} from "@okouai/api-contracts/contracts/skill-import";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { apiBackendUrl } from "../../lib/api-backend-url";
import { badRequestMessage, notFound } from "../../lib/error";
import { webUrl } from "../../lib/web-url";
import type { SkillImportAuth } from "../../types/auth";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  generateSkillImportToken,
  verifySkillImportToken,
} from "../auth/tokens";
import { authorization$, request$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  countSkillsImportedInSession,
  findOwnPrivateWorkflowIdByName,
  resolveSkillImportAgentId,
} from "../services/skill-import.service";
import { safeSync } from "../utils";
import { createWorkflowRecord$ } from "./workflows";

const BEARER_PREFIX = "Bearer ";

/** Unpaired surrogates: representable in JSON, but not storable as text. */
const LONE_SURROGATE_PATTERN = /\p{Cs}/u;
const NUL = "\u0000";

function sessionInvalid(message: string) {
  return {
    status: 401 as const,
    body: { error: { message, code: SKILL_IMPORT_SESSION_INVALID_CODE } },
  };
}

function skillTooLarge(message: string) {
  return {
    status: 413 as const,
    body: { error: { message, code: SKILL_IMPORT_TOO_LARGE_CODE } },
  };
}

function binaryUnsupported(message: string) {
  return {
    status: 400 as const,
    body: { error: { message, code: SKILL_IMPORT_BINARY_CODE } },
  };
}

function skillNameTaken(message: string) {
  return {
    status: 409 as const,
    body: { error: { message, code: SKILL_IMPORT_NAME_TAKEN_CODE } },
  };
}

function sessionLimitReached(message: string) {
  return {
    status: 429 as const,
    body: { error: { message, code: SKILL_IMPORT_SESSION_LIMIT_CODE } },
  };
}

function uploadUrl(): string {
  return new URL(
    skillImportSkillsContract.upload.path,
    apiBackendUrl() ?? webUrl(),
  ).toString();
}

function skillImportDisabled() {
  return {
    status: 403 as const,
    body: {
      error: { message: "Skill import is not enabled", code: "FORBIDDEN" },
    },
  };
}

/**
 * Skill import is the onboarding skills step's backend, so it rolls out with
 * that flow. Both routes check it: the session route so no token can be minted
 * while the flow is off, and the upload route so turning it off also stops a
 * session that already holds one.
 */
const skillImportEnabled$ = command(
  async (
    { get },
    identity: { readonly orgId: string; readonly userId: string },
  ): Promise<boolean> => {
    const overrides = await get(
      userFeatureSwitchOverrides(identity.orgId, identity.userId),
    );
    return isFeatureEnabled(FeatureSwitchKey.OnboardingSourcesFirst, {
      orgId: identity.orgId,
      userId: identity.userId,
      overrides,
    });
  },
);

const createSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const enabled = await set(skillImportEnabled$, {
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    if (!enabled) {
      return skillImportDisabled();
    }

    const agentId = await resolveSkillImportAgentId(get(db$), {
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    if (!agentId) {
      return notFound("This organization has no default agent to import into");
    }

    const session = generateSkillImportToken(auth.userId, auth.orgId, agentId);
    // The token is a credential; keep it out of every cache on the way back.
    set(setResHeader$, "Cache-Control", "no-store");
    return {
      status: 200 as const,
      body: {
        uploadUrl: uploadUrl(),
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        limits: SKILL_IMPORT_LIMITS,
      },
    };
  },
);

function resolveSession(
  authHeader: string | undefined,
): SkillImportAuth | null {
  if (!authHeader?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return verifySkillImportToken(authHeader.slice(BEARER_PREFIX.length));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isImportableText(value: string): boolean {
  return !value.includes(NUL) && !LONE_SURROGATE_PATTERN.test(value);
}

/**
 * Text-only v1: report the first field carrying content a text skill cannot
 * hold. This covers the metadata as well, because PostgreSQL rejects a NUL in a
 * text value and rewrites an unpaired surrogate, so an unchecked field would
 * turn this documented refusal into a failed write or altered content. A
 * non-text path is named by position so the reply never echoes the bytes.
 */
function firstBinaryField(body: SkillImportRequest): string | null {
  const textFields = [
    ["instruction", body.instruction],
    ["displayName", body.displayName],
    ["description", body.description],
  ] as const;
  for (const [field, value] of textFields) {
    if (value !== undefined && !isImportableText(value)) {
      return field;
    }
  }
  for (const [index, file] of (body.files ?? []).entries()) {
    if (!isImportableText(file.path)) {
      return `files[${String(index)}].path`;
    }
    if (!isImportableText(file.content)) {
      return file.path;
    }
  }
  return null;
}

function skillSizeError(body: SkillImportRequest) {
  const instructionBytes = utf8Bytes(body.instruction);
  if (instructionBytes > SKILL_IMPORT_LIMITS.maxInstructionBytes) {
    return skillTooLarge(
      `Instruction is ${String(instructionBytes)} bytes, over the ${String(
        SKILL_IMPORT_LIMITS.maxInstructionBytes,
      )} byte limit`,
    );
  }

  const files = body.files ?? [];
  if (files.length > SKILL_IMPORT_LIMITS.maxFilesPerSkill) {
    return skillTooLarge(
      `A skill may attach at most ${String(
        SKILL_IMPORT_LIMITS.maxFilesPerSkill,
      )} files`,
    );
  }

  let totalBytes = 0;
  for (const file of files) {
    const fileBytes = utf8Bytes(file.content);
    if (fileBytes > SKILL_IMPORT_LIMITS.maxFileBytes) {
      return skillTooLarge(
        `File "${file.path}" is over the ${String(
          SKILL_IMPORT_LIMITS.maxFileBytes,
        )} byte limit`,
      );
    }
    totalBytes += fileBytes;
  }
  if (totalBytes > SKILL_IMPORT_LIMITS.maxTotalFileBytes) {
    return skillTooLarge(
      `Attached files total ${String(totalBytes)} bytes, over the ${String(
        SKILL_IMPORT_LIMITS.maxTotalFileBytes,
      )} byte limit`,
    );
  }

  return null;
}

const uploadBody$ = bodyResultOf(skillImportSkillsContract.upload);

/**
 * Measures and decodes the payload exactly as it arrived, so the byte budget
 * and the UTF-8 rule apply to the transmitted bytes rather than to a re-encoded
 * copy. The contract body parser then reads the same cached bytes.
 */
const validatePayloadBytes$ = command(async ({ get }, signal: AbortSignal) => {
  const payload = await get(request$).arrayBuffer();
  signal.throwIfAborted();
  if (payload.byteLength > SKILL_IMPORT_LIMITS.maxRequestBytes) {
    return skillTooLarge(
      `Request body is ${String(payload.byteLength)} bytes, over the ${String(
        SKILL_IMPORT_LIMITS.maxRequestBytes,
      )} byte limit`,
    );
  }

  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  });
  if (!("ok" in decoded)) {
    return binaryUnsupported("Request body is not valid UTF-8 text");
  }

  return null;
});

const uploadSkillInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const session = resolveSession(get(authorization$));
  if (!session) {
    return sessionInvalid(
      "Skill import session is missing, invalid, or expired",
    );
  }

  const enabled = await set(skillImportEnabled$, {
    orgId: session.orgId,
    userId: session.userId,
  });
  signal.throwIfAborted();
  if (!enabled) {
    return skillImportDisabled();
  }

  // Reject an oversize upload on its declared length before buffering it.
  const declaredLength = Number(get(request$).header("content-length"));
  if (declaredLength > SKILL_IMPORT_LIMITS.maxRequestBytes) {
    return skillTooLarge(
      `Request body is over the ${String(
        SKILL_IMPORT_LIMITS.maxRequestBytes,
      )} byte limit`,
    );
  }

  const payloadError = await set(validatePayloadBytes$, signal);
  if (payloadError) {
    return payloadError;
  }

  const bodyResult = await get(uploadBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const binaryField = firstBinaryField(body);
  if (binaryField !== null) {
    return binaryUnsupported(
      `"${binaryField}" is not text; this version imports text skills only`,
    );
  }

  const sizeError = skillSizeError(body);
  if (sizeError) {
    return sizeError;
  }

  const name = normalizeSkillImportName(body.name);
  if (!name) {
    return badRequestMessage(
      `Skill name "${body.name}" cannot be normalized into a slug`,
    );
  }

  const imported = await countSkillsImportedInSession(get(db$), {
    agentId: session.agentId,
    userId: session.userId,
    since: new Date(session.issuedAtSeconds * 1000),
  });
  signal.throwIfAborted();
  if (imported >= SKILL_IMPORT_LIMITS.maxSkillsPerSession) {
    return sessionLimitReached(
      `This session already imported ${String(
        SKILL_IMPORT_LIMITS.maxSkillsPerSession,
      )} skills; open a new import session to continue`,
    );
  }

  const existingId = await findOwnPrivateWorkflowIdByName(get(db$), {
    orgId: session.orgId,
    agentId: session.agentId,
    ownerUserId: session.userId,
    name,
  });
  signal.throwIfAborted();
  if (existingId) {
    return {
      status: 200 as const,
      body: {
        outcome: "skipped" as const,
        reason: "name_exists" as const,
        workflowId: existingId,
        name,
      },
    };
  }

  const created = await set(
    createWorkflowRecord$,
    {
      orgId: session.orgId,
      member: { userId: session.userId, role: "member" },
      body: {
        agentId: session.agentId,
        name,
        instruction: body.instruction,
        ...(body.displayName === undefined
          ? {}
          : { displayName: body.displayName }),
        ...(body.description === undefined
          ? {}
          : { description: body.description }),
        ...(body.files ? { files: body.files } : {}),
      },
      visibility: "private" as const,
    },
    signal,
  );
  if (created.kind === "error") {
    if (created.response.status === 409) {
      return skillNameTaken(created.response.body.error.message);
    }
    // The agent this session targets is gone or no longer visible, so the
    // session itself can no longer be completed.
    return sessionInvalid(
      "Skill import session is no longer valid; request a new import link",
    );
  }

  return {
    status: 201 as const,
    body: { outcome: "created" as const, workflowId: created.workflowId, name },
  };
});

export const skillImportRoutes: readonly RouteEntry[] = [
  {
    route: skillImportSessionsContract.create,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      createSessionInner$,
    ),
  },
  {
    // Deliberately outside `authRoute`: the session credential is verified here
    // so it can never authenticate another route.
    route: skillImportSkillsContract.upload,
    handler: uploadSkillInner$,
  },
];
