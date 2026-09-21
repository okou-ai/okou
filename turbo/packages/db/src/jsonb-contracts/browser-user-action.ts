import {
  BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH,
  BROWSER_USER_ACTION_MAX_FIELDS,
  BROWSER_USER_ACTION_MAX_KEY_LENGTH,
  BROWSER_USER_ACTION_MAX_LABEL_LENGTH,
  type BrowserUserActionFieldKind,
} from "@okouai/api-contracts/contracts/browser-user-actions";

export interface BrowserUserActionInputTarget {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly fieldKind: BrowserUserActionFieldKind;
  readonly required: boolean;
  readonly backendNodeId: number;
  readonly fingerprint: {
    readonly tagName: "INPUT" | "TEXTAREA";
    readonly inputType: string;
  };
}

export type BrowserUserActionPayload =
  | {
      readonly version: 1;
      readonly kind: "input";
      readonly fields: readonly BrowserUserActionInputTarget[];
    }
  | {
      readonly version: 1;
      readonly kind: "direct_interaction";
      readonly reason: string;
    };

export function browserUserActionFieldSupportsTarget(
  fieldKind: BrowserUserActionFieldKind,
  fingerprint: BrowserUserActionInputTarget["fingerprint"],
): boolean {
  if (fingerprint.tagName === "TEXTAREA") {
    return fieldKind === "text" && fingerprint.inputType === "textarea";
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

function decodeField(value: unknown): BrowserUserActionInputTarget | null {
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
    !["text", "username", "password", "one_time_code"].includes(
      String(field.fieldKind),
    ) ||
    typeof field.required !== "boolean" ||
    !Number.isSafeInteger(field.backendNodeId) ||
    Number(field.backendNodeId) <= 0 ||
    !fingerprint ||
    !hasOnlyKeys(fingerprint, ["tagName", "inputType"]) ||
    (fingerprint.tagName !== "INPUT" && fingerprint.tagName !== "TEXTAREA") ||
    !boundedString(fingerprint.inputType, 0, 64)
  ) {
    return null;
  }
  const fieldKind = field.fieldKind as BrowserUserActionFieldKind;
  const tagName: "INPUT" | "TEXTAREA" =
    fingerprint.tagName === "INPUT" ? "INPUT" : "TEXTAREA";
  const safeFingerprint: BrowserUserActionInputTarget["fingerprint"] = {
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

/** Reject unknown versions and unsafe shapes instead of guessing at old data. */
export function parseBrowserUserActionPayload(
  value: unknown,
): BrowserUserActionPayload {
  const payload = objectValue(value);
  if (!payload || payload.version !== 1) {
    throw new Error("Unsupported Browser user-action payload version");
  }
  if (
    payload.kind === "direct_interaction" &&
    hasOnlyKeys(payload, ["version", "kind", "reason"]) &&
    boundedString(payload.reason, 1, BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH)
  ) {
    return { version: 1, kind: payload.kind, reason: payload.reason };
  }
  if (
    payload.kind === "input" &&
    hasOnlyKeys(payload, ["version", "kind", "fields"]) &&
    Array.isArray(payload.fields) &&
    payload.fields.length >= 1 &&
    payload.fields.length <= BROWSER_USER_ACTION_MAX_FIELDS
  ) {
    const fields = payload.fields.map(decodeField);
    if (
      fields.some((field) => {
        return field === null;
      })
    ) {
      throw new Error("Invalid Browser user-action input payload");
    }
    const decoded = fields as BrowserUserActionInputTarget[];
    if (
      new Set(
        decoded.map((field) => {
          return field.key;
        }),
      ).size !== decoded.length
    ) {
      throw new Error("Duplicate Browser user-action input field key");
    }
    if (
      new Set(
        decoded.map((field) => {
          return field.backendNodeId;
        }),
      ).size !== decoded.length
    ) {
      throw new Error("Duplicate Browser user-action backend node ID");
    }
    return { version: 1, kind: payload.kind, fields: decoded };
  }
  throw new Error("Invalid Browser user-action payload");
}
