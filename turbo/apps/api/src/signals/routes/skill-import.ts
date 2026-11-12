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
  type SkillImportSkippedFile,
} from "@okouai/api-contracts/contracts/skill-import";
import {
  normalizeWorkflowAttachmentFiles,
  workflowAttachmentHash,
  workflowAttachmentPath,
  type WorkflowAttachmentFile,
} from "@okouai/core/workflow-attachment-bundle";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { command, computed } from "ccstate";
import { and, asc, count, eq, isNull, or } from "drizzle-orm";

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
import { waitUntil } from "../context/wait-until";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import { recordSkillImportFact } from "../services/skill-import-telemetry";
import { workflowSummary } from "../services/workflow-data.service";
import { WorkflowAttachmentError } from "../services/workflow-attachments.service";
import type { RouteEntry } from "../route-entry";
import { safeSync, settle } from "../utils";
import { createWorkflowRecord$, type WorkflowCreationInput } from "./workflows";

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

const sessionBody$ = bodyResultOf(skillImportSessionsContract.create);

const createSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(sessionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const [selectedAgent] = await get(db$)
      .select({ agentId: agents.id })
      .from(orgMetadata)
      .innerJoin(
        agents,
        and(
          eq(agents.id, orgMetadata.defaultAgentId),
          eq(agents.orgId, orgMetadata.orgId),
        ),
      )
      .where(
        and(
          eq(orgMetadata.orgId, auth.orgId),
          or(eq(agents.visibility, "public"), eq(agents.owner, auth.userId)),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const agentId = selectedAgent?.agentId ?? null;
    if (!agentId) {
      return notFound("This organization has no default agent to import into");
    }

    const sessionId = randomUUID();
    const session = generateSkillImportToken(
      auth.userId,
      auth.orgId,
      agentId,
      bodyResult.data.provider,
      sessionId,
    );
    waitUntil(
      recordSkillImportFact({
        event: "session_created",
        userId: auth.userId,
        orgId: auth.orgId,
        sessionId,
        provider: bodyResult.data.provider,
      }),
    );
    // The token is a credential; keep it out of every cache on the way back.
    set(setResHeader$, "Cache-Control", "no-store");
    return {
      status: 200 as const,
      body: {
        sessionId,
        uploadUrl: uploadUrl(),
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        limits: SKILL_IMPORT_LIMITS,
      },
    };
  },
);

const sessionSkillsParams$ = pathParamsOf(
  skillImportSessionsContract.listSkills,
);

const listSessionSkillsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const { sessionId } = await get(sessionSkillsParams$);
  const rows = await get(db$)
    .select({
      workflow: {
        id: workflows.id,
        agentId: workflows.agentId,
        name: workflows.name,
        visibility: workflows.visibility,
        ownerUserId: workflows.ownerUserId,
        displayName: workflows.displayName,
        description: workflows.description,
        officialDefinitionName: workflows.officialDefinitionName,
        officialInstallationState: workflows.officialInstallationState,
        importSource: workflows.importSource,
        createdAt: workflows.createdAt,
      },
      agent: {
        id: agents.id,
        owner: agents.owner,
        visibility: agents.visibility,
        name: agents.name,
        displayName: agents.displayName,
      },
    })
    .from(workflows)
    .innerJoin(
      agents,
      and(eq(agents.id, workflows.agentId), eq(agents.orgId, workflows.orgId)),
    )
    .where(
      and(
        eq(workflows.importSessionId, sessionId),
        eq(workflows.orgId, auth.orgId),
        eq(workflows.ownerUserId, auth.userId),
        eq(workflows.createdBy, auth.userId),
        isNull(workflows.officialDefinitionName),
        or(eq(agents.visibility, "public"), eq(agents.owner, auth.userId)),
      ),
    )
    .orderBy(asc(workflows.createdAt), asc(workflows.id));
  return {
    status: 200 as const,
    body: rows.map(({ workflow, agent }) => {
      return workflowSummary({
        workflow,
        agent,
        member: { userId: auth.userId, role: auth.orgRole ?? "member" },
      });
    }),
  };
});

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
 * turn this documented refusal into a failed write or altered content.
 * Supplementary files are checked separately and can be skipped.
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
  return null;
}

function importableSkillFiles(input: SkillImportRequest["files"]) {
  const files: WorkflowAttachmentFile[] = [];
  const duplicates = new Map<
    string,
    { readonly index: number; readonly path: string }
  >();
  const skippedFiles: SkillImportSkippedFile[] = [];
  let totalBytes = 0;
  for (const file of input ?? []) {
    if (!isImportableText(file.path) || !isImportableText(file.content)) {
      skippedFiles.push({ path: file.path, reason: "binary_content" });
      continue;
    }
    // Absolute and drive-relative paths cannot identify a file relative to the skill.
    if (win32.parse(file.path).root) {
      skippedFiles.push({ path: file.path, reason: "invalid_path" });
      continue;
    }
    const fileBytes = utf8Bytes(file.content);
    if (fileBytes > SKILL_IMPORT_LIMITS.maxFileBytes) {
      skippedFiles.push({ path: file.path, reason: "size_limit" });
      continue;
    }
    // The writer owns canonical paths, reserved names and file/directory conflicts.
    const attachment = {
      path: file.path.replaceAll("\\", "/"),
      content: Buffer.from(file.content, "utf8"),
    };
    const normalized = safeSync(() => {
      return normalizeWorkflowAttachmentFiles([...files, attachment]);
    });
    if (!("ok" in normalized)) {
      skippedFiles.push({ path: file.path, reason: "invalid_path" });
      continue;
    }
    const identity = `${workflowAttachmentPath(attachment.path)}\0${workflowAttachmentHash(attachment.content)}`;
    const duplicate = duplicates.get(identity);
    if (duplicate) {
      // Retain the greatest raw alias so the writer's duplicate-path winner is unchanged.
      if (attachment.path > duplicate.path) {
        files[duplicate.index] = attachment;
        duplicates.set(identity, {
          index: duplicate.index,
          path: attachment.path,
        });
      }
      continue;
    }
    if (
      totalBytes + fileBytes > SKILL_IMPORT_LIMITS.maxTotalFileBytes ||
      files.length >= SKILL_IMPORT_LIMITS.maxFilesPerSkill
    ) {
      skippedFiles.push({ path: file.path, reason: "size_limit" });
      continue;
    }
    duplicates.set(identity, { index: files.length, path: attachment.path });
    files.push(attachment);
    totalBytes += fileBytes;
  }
  return {
    files: normalizeWorkflowAttachmentFiles(files).map((file) => {
      return { path: file.path, content: file.content.toString("utf8") };
    }),
    skippedFiles,
  };
}

const uploadBody$ = bodyResultOf(skillImportSkillsContract.upload);

/**
 * Measures and decodes the payload exactly as it arrived, so the byte budget
 * and the UTF-8 rule apply to the transmitted bytes rather than to a re-encoded
 * copy. The contract body parser then reads the same cached bytes.
 */
const validatePayloadBytes$ = command(async ({ get }, signal: AbortSignal) => {
  // Reject an oversize upload on its declared length before buffering it.
  const declaredLength = Number(get(request$).header("content-length"));
  if (declaredLength > SKILL_IMPORT_LIMITS.maxRequestBytes) {
    return skillTooLarge(
      `Request body is over the ${String(
        SKILL_IMPORT_LIMITS.maxRequestBytes,
      )} byte limit`,
    );
  }
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

const createImportedSkill$ = command(
  async ({ set }, creation: WorkflowCreationInput, signal: AbortSignal) => {
    const attempt = await settle(
      set(createWorkflowRecord$, creation, signal),
      signal,
    );
    if (attempt.ok) {
      return { created: attempt.value, skippedFiles: [] };
    }
    if (
      !(attempt.error instanceof WorkflowAttachmentError) ||
      !creation.body.files?.length
    ) {
      throw attempt.error;
    }
    // These errors precede publication. Keep durable cleanup for the abandoned
    // upload, and create a fresh instruction-only Workflow. Never retry a commit.
    return {
      created: await set(
        createWorkflowRecord$,
        { ...creation, body: { ...creation.body, files: [] } },
        signal,
      ),
      skippedFiles: creation.body.files.map((file): SkillImportSkippedFile => {
        return { path: file.path, reason: "upload_failed" };
      }),
    };
  },
);

const uploadSkillInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const session = resolveSession(get(authorization$));
  if (!session) {
    return sessionInvalid(
      "Skill import session is missing, invalid, or expired",
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

  const instructionBytes = utf8Bytes(body.instruction);
  if (instructionBytes > SKILL_IMPORT_LIMITS.maxInstructionBytes) {
    return skillTooLarge(
      `Instruction is ${String(instructionBytes)} bytes, over the ${String(
        SKILL_IMPORT_LIMITS.maxInstructionBytes,
      )} byte limit`,
    );
  }

  const name = normalizeSkillImportName(body.name);
  if (!name) {
    return badRequestMessage(
      `Skill name "${body.name}" cannot be normalized into a slug`,
    );
  }

  const [selectedCount] = await get(db$)
    .select({ imported: count() })
    .from(workflows)
    .where(
      and(
        eq(workflows.agentId, session.agentId),
        eq(workflows.createdBy, session.userId),
        eq(workflows.importSessionId, session.sessionId),
        isNull(workflows.officialDefinitionName),
      ),
    );
  signal.throwIfAborted();
  const imported = selectedCount?.imported ?? 0;
  if (imported >= SKILL_IMPORT_LIMITS.maxSkillsPerSession) {
    return sessionLimitReached(
      `This session already imported ${String(
        SKILL_IMPORT_LIMITS.maxSkillsPerSession,
      )} skills; open a new import session to continue`,
    );
  }

  const [selectedWorkflow] = await get(db$)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, session.orgId),
        eq(workflows.agentId, session.agentId),
        eq(workflows.ownerUserId, session.userId),
        eq(workflows.name, name),
        eq(workflows.visibility, "private"),
        isNull(workflows.officialDefinitionName),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const existingId = selectedWorkflow?.id ?? null;
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

  const { files, skippedFiles } = importableSkillFiles(body.files);
  const { created, skippedFiles: failedFiles } = await set(
    createImportedSkill$,
    {
      orgId: session.orgId,
      member: { userId: session.userId, role: "member" },
      body: {
        ...body,
        agentId: session.agentId,
        name,
        files,
      },
      visibility: "private" as const,
      importSource: session.provider,
      importSessionId: session.sessionId,
    },
    signal,
  );
  skippedFiles.push(...failedFiles);
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
    body: {
      outcome: "created" as const,
      workflowId: created.workflowId,
      name,
      ...(skippedFiles.length ? { skippedFiles } : {}),
    },
  };
});

export const skillImportRoutes: readonly RouteEntry[] = [
  {
    route: skillImportSessionsContract.listSkills,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listSessionSkillsInner$,
    ),
  },
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
