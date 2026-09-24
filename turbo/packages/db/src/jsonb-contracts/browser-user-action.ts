import {
  BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH,
  BROWSER_USER_ACTION_MAX_FIELDS,
  BROWSER_USER_ACTION_MAX_KEY_LENGTH,
  BROWSER_USER_ACTION_MAX_LABEL_LENGTH,
  BROWSER_USER_ACTION_MAX_TARGET_ID_LENGTH,
  type BrowserUserActionFieldKind,
} from "@okouai/api-contracts/contracts/browser-user-actions";

export interface BrowserUserActionCallbackIdentity {
  readonly clientEventId: string;
  readonly chatThreadSortEventId: string;
}

export interface BrowserUserActionCallbackIds {
  readonly success: BrowserUserActionCallbackIdentity;
  readonly cancellation: BrowserUserActionCallbackIdentity;
}

export interface BrowserUserActionInputField {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly fieldKind: BrowserUserActionFieldKind;
  readonly required: boolean;
  readonly backendNodeId: number;
  readonly fingerprint: {
    readonly tagName: "INPUT" | "TEXTAREA" | "SELECT";
    readonly inputType: string;
  };
}

export interface BrowserUserActionInputTarget {
  readonly pageTargetId: string;
  readonly documentLoaderId: string;
  readonly siteOrigin: string;
  readonly pageUrlHash: string;
  readonly fields: readonly BrowserUserActionInputField[];
}

export interface BrowserUserActionPayload {
  readonly version: 1;
  readonly kind: "input";
  readonly callbackIds: BrowserUserActionCallbackIds;
  readonly target: BrowserUserActionInputTarget;
}

export function browserUserActionFieldSupportsTarget(
  fieldKind: BrowserUserActionFieldKind,
  fingerprint: BrowserUserActionInputField["fingerprint"],
): boolean {
  if (fingerprint.tagName === "TEXTAREA") {
    return fieldKind === "text" && fingerprint.inputType === "textarea";
  }
  if (fingerprint.tagName === "SELECT") {
    return (
      fieldKind === "select" &&
      ["select-one", "select-multiple"].includes(fingerprint.inputType)
    );
  }
  switch (fieldKind) {
    case "text":
      return ["text", "email", "tel", "url", "search"].includes(
        fingerprint.inputType,
      );
    case "username":
      return ["text", "email", "tel"].includes(fingerprint.inputType);
    case "password":
      return fingerprint.inputType === "password";
    case "one_time_code":
      return ["text", "tel", "number"].includes(fingerprint.inputType);
    case "number":
      return fingerprint.inputType === "number";
    case "select":
      return false;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => {
    return allowedKeys.has(key);
  });
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function decodeCallbackIdentity(
  value: unknown,
): BrowserUserActionCallbackIdentity | null {
  const identity = objectValue(value);
  if (
    !identity ||
    !hasOnlyKeys(identity, ["clientEventId", "chatThreadSortEventId"]) ||
    !uuid(identity.clientEventId) ||
    !uuid(identity.chatThreadSortEventId)
  ) {
    return null;
  }
  return {
    clientEventId: identity.clientEventId,
    chatThreadSortEventId: identity.chatThreadSortEventId,
  };
}

function decodeCallbackIds(
  value: unknown,
): BrowserUserActionCallbackIds | null {
  const callbackIds = objectValue(value);
  if (!callbackIds || !hasOnlyKeys(callbackIds, ["success", "cancellation"])) {
    return null;
  }
  const success = decodeCallbackIdentity(callbackIds.success);
  const cancellation = decodeCallbackIdentity(callbackIds.cancellation);
  return success && cancellation ? { success, cancellation } : null;
}

function decodeField(value: unknown): BrowserUserActionInputField | null {
  const field = objectValue(value);
  const fingerprint = objectValue(field?.fingerprint);
  if (
    !field ||
    !hasOnlyKeys(field, [
      "key",
      "label",
      "description",
      "fieldKind",
      "required",
      "backendNodeId",
      "fingerprint",
    ]) ||
    !boundedString(field.key, 1, BROWSER_USER_ACTION_MAX_KEY_LENGTH) ||
    !boundedString(field.label, 1, BROWSER_USER_ACTION_MAX_LABEL_LENGTH) ||
    (field.description !== undefined &&
      !boundedString(
        field.description,
        0,
        BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH,
      )) ||
    ![
      "text",
      "username",
      "password",
      "one_time_code",
      "number",
      "select",
    ].includes(String(field.fieldKind)) ||
    typeof field.required !== "boolean" ||
    !Number.isSafeInteger(field.backendNodeId) ||
    Number(field.backendNodeId) <= 0 ||
    !fingerprint ||
    !hasOnlyKeys(fingerprint, ["tagName", "inputType"]) ||
    (fingerprint.tagName !== "INPUT" &&
      fingerprint.tagName !== "TEXTAREA" &&
      fingerprint.tagName !== "SELECT") ||
    !boundedString(fingerprint.inputType, 0, 64)
  ) {
    return null;
  }
  const fieldKind = field.fieldKind as BrowserUserActionFieldKind;
  const tagName: "INPUT" | "TEXTAREA" | "SELECT" =
    fingerprint.tagName === "INPUT"
      ? "INPUT"
      : fingerprint.tagName === "SELECT"
        ? "SELECT"
        : "TEXTAREA";
  const safeFingerprint: BrowserUserActionInputField["fingerprint"] = {
    tagName,
    inputType: fingerprint.inputType,
  };
  if (!browserUserActionFieldSupportsTarget(fieldKind, safeFingerprint)) {
    return null;
  }
  return {
    key: field.key,
    label: field.label,
    ...(field.description === undefined
      ? {}
      : { description: field.description as string }),
    fieldKind,
    required: field.required,
    backendNodeId: Number(field.backendNodeId),
    fingerprint: safeFingerprint,
  };
}

function httpOrigin(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      value === url.origin
    );
  } catch {
    return false;
  }
}

function decodeInputTarget(
  value: unknown,
): BrowserUserActionInputTarget | null {
  const target = objectValue(value);
  if (
    !target ||
    !hasOnlyKeys(target, [
      "pageTargetId",
      "documentLoaderId",
      "siteOrigin",
      "pageUrlHash",
      "fields",
    ]) ||
    !boundedString(
      target.pageTargetId,
      1,
      BROWSER_USER_ACTION_MAX_TARGET_ID_LENGTH,
    ) ||
    !boundedString(
      target.documentLoaderId,
      1,
      BROWSER_USER_ACTION_MAX_TARGET_ID_LENGTH,
    ) ||
    !httpOrigin(target.siteOrigin) ||
    typeof target.pageUrlHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(target.pageUrlHash) ||
    !Array.isArray(target.fields) ||
    target.fields.length < 1 ||
    target.fields.length > BROWSER_USER_ACTION_MAX_FIELDS
  ) {
    return null;
  }
  const fields = target.fields.map(decodeField);
  if (
    fields.some((field) => {
      return field === null;
    })
  ) {
    return null;
  }
  const decoded = fields as BrowserUserActionInputField[];
  if (
    new Set(
      decoded.map((field) => {
        return field.key;
      }),
    ).size !== decoded.length
  ) {
    return null;
  }
  if (
    new Set(
      decoded.map((field) => {
        return field.backendNodeId;
      }),
    ).size !== decoded.length
  ) {
    return null;
  }
  return {
    pageTargetId: target.pageTargetId,
    documentLoaderId: target.documentLoaderId,
    siteOrigin: target.siteOrigin,
    pageUrlHash: target.pageUrlHash,
    fields: decoded,
  };
}

/** Reject unknown versions and unsafe shapes instead of guessing at old data. */
export function parseBrowserUserActionPayload(
  value: unknown,
): BrowserUserActionPayload {
  const payload = objectValue(value);
  if (!payload || payload.version !== 1) {
    throw new Error("Unsupported Browser user-action payload version");
  }
  const callbackIds = decodeCallbackIds(payload.callbackIds);
  if (!callbackIds) {
    throw new Error("Invalid Browser user-action callback identities");
  }
  if (
    payload.kind === "input" &&
    hasOnlyKeys(payload, ["version", "kind", "callbackIds", "target"])
  ) {
    const target = decodeInputTarget(payload.target);
    if (target) {
      return { version: 1, kind: payload.kind, callbackIds, target };
    }
  }
  throw new Error("Invalid Browser user-action payload");
}
