import { randomUUID } from "node:crypto";
import type { ComputerUsePermissionState } from "./computer-use-types";
import {
  ComputerUseNativeHelperError,
  createComputerUseNativeBackend,
  type ComputerUseNativeBackend,
  type ComputerUseNativeForegroundRecoveryPolicy,
} from "./computer-use-native";

export const SUPPORTED_COMPUTER_USE_CAPABILITIES = [
  "apps.list",
  "app.state",
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
] as const;

type AccessibilityElementClickableKind = "mouse" | "pick" | "press" | "select";
const DEFAULT_FOREGROUND_RECOVERY_POLICY =
  "on-window-unavailable" satisfies ComputerUseNativeForegroundRecoveryPolicy;

export interface ComputerUseCommand {
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly timeoutMs?: number | null;
  readonly createdAt?: string;
  readonly claimedAt?: string | null;
}

export interface AccessibilityElementSnapshot {
  readonly id: string;
  readonly index?: number;
  readonly role?: string;
  readonly subrole?: string;
  readonly roleDescription?: string;
  readonly name?: string;
  readonly value?: string;
  readonly valueType?: string;
  readonly valueSettable?: boolean;
  readonly description?: string;
  readonly help?: string;
  readonly placeholderValue?: string;
  readonly visibleText?: string;
  readonly text?: string;
  readonly titleElementText?: string;
  readonly columnTitles?: readonly string[];
  readonly identifier?: string;
  readonly url?: string;
  readonly focused?: boolean;
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly hidden?: boolean;
  readonly actions?: readonly string[];
  readonly pressable?: boolean;
  readonly pickable?: boolean;
  readonly selectable?: boolean;
  readonly mouseClickable?: boolean;
  readonly clickableKind?: AccessibilityElementClickableKind;
  readonly bounds?: ComputerUseCoordinateBounds;
  readonly children?: readonly AccessibilityElementSnapshot[];
}

export interface AccessibilityAppStateSnapshot {
  readonly app: string;
  readonly appDisplayName?: string;
  readonly bundleId?: string;
  readonly pid?: number;
  readonly appPath?: string;
  readonly windowTitle?: string;
  readonly windowId?: number;
  readonly windowFrame?: ComputerUseCoordinateBounds;
  readonly windowIsOnScreen?: boolean;
  readonly windowOnCurrentSpace?: boolean;
  readonly currentSpaceId?: number;
  readonly windowSpaceIds?: readonly number[];
  readonly snapshotId: string;
  readonly elements: readonly AccessibilityElementSnapshot[];
  readonly elementIdsByIndex?: readonly string[];
  readonly focusedElementIndex?: number;
  readonly nodeCount?: number;
  readonly truncated?: boolean;
  readonly truncationReasons?: readonly string[];
  readonly screenshot?: string;
  readonly screenshotMimeType?: string;
  readonly screenshotSource?: "window" | "screen";
  readonly screenshotSourceName?: string;
  readonly screenshotWidth?: number;
  readonly screenshotHeight?: number;
  readonly screenshotSourceBounds?: ComputerUseCoordinateBounds;
}

interface AccessibilitySnapshotOutputLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxChildrenPerNode: number;
}

export const ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS =
  Object.freeze<AccessibilitySnapshotOutputLimits>({
    maxDepth: 32,
    maxNodes: 1_200,
    maxChildrenPerNode: 120,
  });

const GENERIC_WRAPPER_ROLES = new Set(["AXGroup", "AXUnknown"]);
const REDUNDANT_LABEL_CHILD_ROLES = new Set(["AXImage", "AXStaticText"]);
const PARENT_TEXT_COVERED_ROLES = new Set([
  "AXButton",
  "AXGroup",
  "AXHeading",
  "AXImage",
  "AXLink",
  "AXStaticText",
  "AXUnknown",
]);
const TEXT_COVERING_PARENT_ROLES = new Set(["AXButton", "AXHeading", "AXLink"]);

interface ComputerUseAppStateScreenshot {
  readonly dataUrl: string;
  readonly mimeType: string;
  readonly source: "window" | "screen";
  readonly sourceName: string;
  readonly width: number;
  readonly height: number;
  readonly sourceBounds?: ComputerUseCoordinateBounds;
}

export interface ComputerUseCommandSuccess {
  readonly status: "succeeded";
  readonly result: Record<string, unknown>;
}

export interface ComputerUseCommandFailure {
  readonly status: "failed";
  readonly error: {
    readonly code:
      | "permission_denied"
      | "accessibility_unavailable"
      | "automation_permission_denied"
      | "element_action_unsupported"
      | "element_not_editable"
      | "window_unavailable"
      | "screen_recording_unavailable"
      | "app_not_found"
      | "app_open_failed"
      | "unsupported_command"
      | "command_timeout"
      | "feature_disabled"
      | "plugin_disabled"
      | "plugin_unavailable"
      | "plugin_restarting"
      | "unknown_plugin"
      | "unknown_tool"
      | "invalid_arguments"
      | "path_denied"
      | "result_too_large"
      | "input_too_large"
      | "mcp_error";
    readonly message: string;
  };
}

export type ComputerUseCommandExecutionResult =
  | ComputerUseCommandSuccess
  | ComputerUseCommandFailure;

export interface ComputerUseCoordinateBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ComputerUseSnapshotMetadata {
  readonly app: string;
  readonly snapshotId: string;
  readonly elementIdsByIndex?: readonly string[];
  readonly focusedElementIndex?: number;
  readonly windowId?: number;
  readonly windowFrame?: ComputerUseCoordinateBounds;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly screenshotSource: "window" | "screen";
  readonly screenshotSourceName: string;
  readonly sourceBounds?: ComputerUseCoordinateBounds;
}

interface IndexedAccessibilitySnapshot {
  readonly snapshot: AccessibilityAppStateSnapshot;
  readonly elementIdsByIndex: readonly string[];
  readonly focusedElementIndex?: number;
}

interface ComputerUseElementTarget {
  readonly elementId?: string;
  readonly elementIndex?: number;
  readonly snapshotId?: string;
}

export type ComputerUseMouseButton = "left" | "right" | "middle";

interface ComputerUseCommandExecutionDependencies {
  readonly snapshotStore?: ComputerUseSnapshotStore;
  readonly platform?: NodeJS.Platform;
  readonly nativeBackend?: ComputerUseNativeBackend;
}

const DEFAULT_SNAPSHOT_STORE_LIMIT = 50;

class UnsupportedComputerUseCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedComputerUseCommandError";
  }
}

function appSnapshotKey(app: string): string {
  return app.trim().toLowerCase();
}

export class ComputerUseSnapshotStore {
  private readonly snapshots = new Map<string, ComputerUseSnapshotMetadata>();
  private readonly latestByApp = new Map<string, string>();

  constructor(private readonly maxEntries = DEFAULT_SNAPSHOT_STORE_LIMIT) {}

  clear(): void {
    this.snapshots.clear();
    this.latestByApp.clear();
  }

  set(metadata: ComputerUseSnapshotMetadata): void {
    const key = this.key(metadata.app, metadata.snapshotId);
    if (this.snapshots.has(key)) {
      this.snapshots.delete(key);
    }
    this.snapshots.set(key, metadata);
    this.latestByApp.set(appSnapshotKey(metadata.app), key);

    while (this.snapshots.size > this.maxEntries) {
      const oldestKey = this.snapshots.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      this.snapshots.delete(oldestKey);
      for (const [appKey, snapshotKey] of this.latestByApp) {
        if (snapshotKey === oldestKey) {
          this.latestByApp.delete(appKey);
        }
      }
    }
  }

  get(app: string, snapshotId: string): ComputerUseSnapshotMetadata | null {
    return this.snapshots.get(this.key(app, snapshotId)) ?? null;
  }

  getLatestForApp(app: string): ComputerUseSnapshotMetadata | null {
    const key = this.latestByApp.get(appSnapshotKey(app));
    return key ? (this.snapshots.get(key) ?? null) : null;
  }

  private key(app: string, snapshotId: string): string {
    return `${appSnapshotKey(app)}\0${snapshotId}`;
  }
}

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function payloadNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadElementIndex(payload: Record<string, unknown>): number | null {
  const value = payload.elementIndex;
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new UnsupportedComputerUseCommandError(
    "elementIndex must be a non-negative integer",
  );
}

function payloadMouseButton(
  payload: Record<string, unknown>,
): ComputerUseMouseButton {
  const value = payload.button;
  if (value === "right" || value === "middle") {
    return value;
  }
  return "left";
}

function payloadClickCount(payload: Record<string, unknown>): number {
  const value = payload.clickCount;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 3
    ? value
    : 1;
}

function payloadForegroundRecoveryPolicy(
  payload: Record<string, unknown>,
): ComputerUseNativeForegroundRecoveryPolicy {
  const value = payloadString(payload, "foregroundRecovery");
  if (value === null) {
    return DEFAULT_FOREGROUND_RECOVERY_POLICY;
  }
  if (
    value === "never" ||
    value === "on-window-unavailable" ||
    value === "always"
  ) {
    return value;
  }
  throw new UnsupportedComputerUseCommandError(
    "foregroundRecovery must be never, on-window-unavailable, or always",
  );
}

function snapshotId(): string {
  return `desktop_${randomUUID()}`;
}

function requireAccessibility(
  permissions: ComputerUsePermissionState,
  platform: NodeJS.Platform,
): ComputerUseCommandFailure | null {
  if (platform !== "darwin") {
    return {
      status: "failed",
      error: {
        code: "accessibility_unavailable",
        message: "Desktop Computer Use is currently implemented for macOS",
      },
    };
  }
  if (!permissions.accessibility) {
    return {
      status: "failed",
      error: {
        code: "permission_denied",
        message: "macOS Accessibility permission is required",
      },
    };
  }
  return null;
}

function requireScreenRecording(
  permissions: ComputerUsePermissionState,
): ComputerUseCommandFailure | null {
  if (!permissions.screenRecording) {
    return {
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: "macOS Screen Recording permission is required",
      },
    };
  }
  return null;
}

function stringHasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function normalizeDisplayText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function normalizeCoverageText(value: string): string {
  return normalizeDisplayText(value)
    .replaceAll(/[•·]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function stringArrayHasValue(value: readonly string[] | undefined): boolean {
  return (
    value !== undefined &&
    value.some((entry) => {
      return normalizeDisplayText(entry).length > 0;
    })
  );
}

function stringValues(value: readonly string[] | undefined): readonly string[] {
  return value ?? [];
}

function elementHasMeaningfulContent(
  element: AccessibilityElementSnapshot,
): boolean {
  return (
    stringHasValue(element.name) ||
    stringHasValue(element.value) ||
    stringHasValue(element.description) ||
    stringHasValue(element.help) ||
    stringHasValue(element.placeholderValue) ||
    stringHasValue(element.visibleText) ||
    stringHasValue(element.text) ||
    stringHasValue(element.titleElementText) ||
    stringArrayHasValue(element.columnTitles) ||
    stringHasValue(element.identifier) ||
    stringHasValue(element.url) ||
    element.focused === true ||
    element.enabled === false ||
    element.selected === true ||
    element.expanded === true ||
    element.pressable === true ||
    element.pickable === true ||
    element.selectable === true ||
    element.clickableKind === "press" ||
    element.clickableKind === "pick" ||
    element.clickableKind === "select" ||
    hasMeaningfulSecondaryAction(element)
  );
}

function hasMeaningfulSecondaryAction(
  element: AccessibilityElementSnapshot,
): boolean {
  return (
    element.actions?.some((action) => {
      return (
        action !== "AXShowMenu" &&
        action !== "AXScrollToVisible" &&
        action !== "AXPress" &&
        !(action === "AXPick" && element.clickableKind === "pick")
      );
    }) === true
  );
}

function shouldElideElement(element: AccessibilityElementSnapshot): boolean {
  if (!element.role || !GENERIC_WRAPPER_ROLES.has(element.role)) {
    return false;
  }
  if (elementHasMeaningfulContent(element)) {
    return false;
  }
  return true;
}

function elementHasDefaultPress(
  element: AccessibilityElementSnapshot,
): boolean {
  return (
    element.pressable === true ||
    element.clickableKind === "press" ||
    element.actions?.includes("AXPress") === true
  );
}

function elementHasIndependentStateOrAction(
  element: AccessibilityElementSnapshot,
): boolean {
  return (
    element.focused === true ||
    element.selected === true ||
    element.enabled === false ||
    element.expanded === true ||
    element.valueSettable === true ||
    element.pickable === true ||
    element.selectable === true ||
    element.clickableKind === "pick" ||
    element.clickableKind === "select" ||
    hasMeaningfulSecondaryAction(element)
  );
}

function normalizedElementLabelValues(
  element: AccessibilityElementSnapshot,
): readonly string[] {
  return [
    element.name,
    element.value,
    element.description,
    element.help,
    element.placeholderValue,
    element.visibleText,
    element.text,
    element.titleElementText,
    ...stringValues(element.columnTitles),
  ]
    .filter((value): value is string => {
      return value !== undefined;
    })
    .map(normalizeCoverageText)
    .filter((value) => {
      return value.length > 0;
    });
}

function normalizedElementTextValues(
  element: AccessibilityElementSnapshot,
): ReadonlySet<string> {
  const values = [
    element.name,
    element.value,
    element.description,
    element.help,
    element.placeholderValue,
    element.visibleText,
    element.text,
    element.titleElementText,
    ...stringValues(element.columnTitles),
    element.identifier,
    element.url,
  ]
    .filter((value): value is string => {
      return value !== undefined;
    })
    .map(normalizeDisplayText)
    .filter((value) => {
      return value.length > 0;
    });
  return new Set(values);
}

function normalizedSubtreeLabelValues(
  element: AccessibilityElementSnapshot,
): readonly string[] {
  const values = [...normalizedElementLabelValues(element)];
  for (const child of element.children ?? []) {
    values.push(...normalizedSubtreeLabelValues(child));
  }
  return values;
}

function textValuesCover(
  parentTexts: readonly string[],
  childTexts: readonly string[],
): boolean {
  const meaningfulChildTexts = childTexts.filter((text) => {
    return text.length > 0;
  });
  return (
    meaningfulChildTexts.length > 0 &&
    meaningfulChildTexts.every((childText) => {
      return parentTexts.some((parentText) => {
        return parentText === childText || parentText.includes(childText);
      });
    })
  );
}

function childHasIndependentSemantics(
  parent: AccessibilityElementSnapshot,
  child: AccessibilityElementSnapshot,
): boolean {
  if (!child.role || !PARENT_TEXT_COVERED_ROLES.has(child.role)) {
    return true;
  }
  if (elementHasIndependentStateOrAction(child)) {
    return true;
  }
  if (
    (child.role === "AXLink" || child.role === "AXButton") &&
    child.role !== parent.role
  ) {
    return true;
  }
  if (
    child.role === "AXLink" &&
    parent.role === "AXLink" &&
    child.url !== undefined &&
    parent.url !== undefined &&
    child.url !== parent.url
  ) {
    return true;
  }
  return (child.children ?? []).some((grandchild) => {
    return childHasIndependentSemantics(parent, grandchild);
  });
}

function childIsCoveredByParentText(
  parent: AccessibilityElementSnapshot,
  child: AccessibilityElementSnapshot,
): boolean {
  if (!parent.role || !TEXT_COVERING_PARENT_ROLES.has(parent.role)) {
    return false;
  }
  if (childHasIndependentSemantics(parent, child)) {
    return false;
  }
  return textValuesCover(
    normalizedElementLabelValues(parent),
    normalizedSubtreeLabelValues(child),
  );
}

function childIsRedundantLabel(
  parent: AccessibilityElementSnapshot,
  child: AccessibilityElementSnapshot,
): boolean {
  if (
    child.role === "AXStaticText" &&
    (child.children ?? []).length === 0 &&
    normalizedElementTextValues(child).size === 0 &&
    !elementHasIndependentStateOrAction(child)
  ) {
    return true;
  }
  if (!child.role || !REDUNDANT_LABEL_CHILD_ROLES.has(child.role)) {
    return false;
  }
  if (child.children && child.children.length > 0) {
    return false;
  }
  const parentTexts = normalizedElementTextValues(parent);
  if (parentTexts.size === 0) {
    return false;
  }
  const duplicatesParentText = [...normalizedElementTextValues(child)].some(
    (text) => {
      return parentTexts.has(text);
    },
  );
  if (!duplicatesParentText) {
    return false;
  }
  if (
    child.focused === true ||
    child.selected === true ||
    child.enabled === false ||
    child.expanded === true ||
    child.pickable === true ||
    child.selectable === true ||
    child.clickableKind === "pick" ||
    child.clickableKind === "select" ||
    hasMeaningfulSecondaryAction(child)
  ) {
    return false;
  }
  if (elementHasDefaultPress(child) && !elementHasDefaultPress(parent)) {
    return false;
  }
  return true;
}

function shouldCompactChild(
  parent: AccessibilityElementSnapshot,
  child: AccessibilityElementSnapshot,
): boolean {
  return (
    childIsRedundantLabel(parent, child) ||
    childIsCoveredByParentText(parent, child)
  );
}

function shallowMenuBarChild(
  element: AccessibilityElementSnapshot,
): AccessibilityElementSnapshot {
  return {
    ...element,
    actions: undefined,
    children: undefined,
  };
}

function compactRawChildren(
  element: AccessibilityElementSnapshot,
): readonly AccessibilityElementSnapshot[] {
  const rawChildren = element.children ?? [];
  if (element.role === "AXMenuBar") {
    return rawChildren.map((child) => {
      return shallowMenuBarChild(child);
    });
  }
  return rawChildren.filter((child) => {
    return !shouldCompactChild(element, child);
  });
}

function pushUniqueReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

export function normalizeAccessibilitySnapshot(
  snapshot: AccessibilityAppStateSnapshot,
  limits: AccessibilitySnapshotOutputLimits = ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
): AccessibilityAppStateSnapshot {
  let nodeCount = 0;
  const truncationReasons: string[] = [];

  const normalizeElement = (
    element: AccessibilityElementSnapshot,
    depth: number,
  ): AccessibilityElementSnapshot[] => {
    if (depth > limits.maxDepth) {
      pushUniqueReason(truncationReasons, "max_depth");
      return [];
    }
    if (
      depth > 0 &&
      element.hidden === true &&
      element.focused !== true &&
      element.selected !== true
    ) {
      return [];
    }

    const semanticChildren = compactRawChildren(element);
    const childEntries = semanticChildren.slice(0, limits.maxChildrenPerNode);
    if (semanticChildren.length > childEntries.length) {
      pushUniqueReason(truncationReasons, "max_children_per_node");
    }

    const elide = shouldElideElement(element);
    if (!elide) {
      if (nodeCount >= limits.maxNodes) {
        pushUniqueReason(truncationReasons, "max_nodes");
        return [];
      }
      nodeCount += 1;
    }

    const children: AccessibilityElementSnapshot[] = [];
    for (const child of childEntries) {
      if (nodeCount >= limits.maxNodes) {
        pushUniqueReason(truncationReasons, "max_nodes");
        break;
      }
      children.push(...normalizeElement(child, depth + 1));
    }

    if (elide) {
      return children;
    }

    const compactedChildren = children.filter((child) => {
      return !shouldCompactChild(element, child);
    });

    return [
      {
        ...element,
        children: compactedChildren.length > 0 ? compactedChildren : undefined,
      },
    ];
  };

  const elements = snapshot.elements.flatMap((element) => {
    return normalizeElement(element, 0);
  });

  const combinedReasons = [
    ...(snapshot.truncationReasons ?? []),
    ...truncationReasons,
  ];

  return {
    ...snapshot,
    elements,
    nodeCount,
    truncated:
      snapshot.truncated === true ||
      combinedReasons.length > 0 ||
      snapshot.nodeCount !== undefined
        ? snapshot.truncated === true || combinedReasons.length > 0
        : undefined,
    truncationReasons:
      combinedReasons.length > 0
        ? [...new Set(combinedReasons)]
        : snapshot.truncationReasons,
  };
}

function unsupportedCommand(message: string): ComputerUseCommandFailure {
  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message,
    },
  };
}

function missingField(field: string): ComputerUseCommandFailure {
  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message: `Missing required payload field: ${field}`,
    },
  };
}

function countSnapshotElements(
  elements: readonly AccessibilityElementSnapshot[],
): number {
  let count = 0;
  for (const element of elements) {
    count += 1 + countSnapshotElements(element.children ?? []);
  }
  return count;
}

function indexAccessibilitySnapshot(
  snapshot: AccessibilityAppStateSnapshot,
): IndexedAccessibilitySnapshot {
  let nextIndex = 0;
  const elementIdsByIndex: string[] = [];
  let focusedElementIndex: number | undefined;

  const indexElement = (
    element: AccessibilityElementSnapshot,
  ): AccessibilityElementSnapshot => {
    const index = nextIndex;
    nextIndex += 1;
    const elementId =
      element.id ??
      (element.index !== undefined
        ? snapshot.elementIdsByIndex?.[element.index]
        : undefined);
    elementIdsByIndex[index] = elementId ?? "";
    if (focusedElementIndex === undefined && element.focused === true) {
      focusedElementIndex = index;
    }

    const children = element.children?.map((child) => {
      return indexElement(child);
    });
    return {
      ...element,
      index,
      ...(children && children.length > 0 ? { children } : {}),
    };
  };

  const elements = snapshot.elements.map((element) => {
    return indexElement(element);
  });

  return {
    snapshot: {
      ...snapshot,
      elements,
      elementIdsByIndex,
      ...(focusedElementIndex !== undefined ? { focusedElementIndex } : {}),
    },
    elementIdsByIndex,
    ...(focusedElementIndex !== undefined ? { focusedElementIndex } : {}),
  };
}

const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXComboBox: "combo box",
  AXDisclosureTriangle: "disclosure triangle",
  AXGroup: "container",
  AXHeading: "heading",
  AXImage: "image",
  AXLink: "link",
  AXList: "list",
  AXMenu: "menu",
  AXMenuBar: "menu bar",
  AXMenuBarItem: "menu bar item",
  AXMenuItem: "menu item",
  AXOutline: "outline",
  AXPopUpButton: "pop up button",
  AXRadioButton: "radio button",
  AXScrollArea: "scroll area",
  AXSlider: "slider",
  AXStaticText: "text",
  AXTabGroup: "tab group",
  AXTable: "table",
  AXTextArea: "text entry area",
  AXTextField: "text field",
  AXToolbar: "toolbar",
  AXUnknown: "container",
});

const DEFAULT_ACTION_NAMES = new Set(["AXPress"]);
const GENERIC_WEB_ACTION_NAMES = new Set(["AXShowMenu", "AXScrollToVisible"]);
const MENU_ACTION_NOISE_NAMES = new Set(["AXCancel", "AXPick"]);
const MENU_ROLE_NAMES = new Set([
  "AXMenu",
  "AXMenuBar",
  "AXMenuBarItem",
  "AXMenuItem",
]);
const PRIMARY_CLICK_ROLE_NAMES = new Set([
  "AXButton",
  "AXCheckBox",
  "AXDisclosureTriangle",
  "AXMenuBarItem",
  "AXMenuItem",
  "AXPopUpButton",
  "AXRadioButton",
]);

const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  AXCancel: "Cancel",
  AXConfirm: "Confirm",
  AXDecrement: "Decrement",
  AXDelete: "Delete",
  AXIncrement: "Increment",
  AXPick: "Pick",
  AXRaise: "Raise",
  AXShowMenu: "Show Menu",
});

function normalizeText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateText(value: string, maxLength = 180): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

function formatText(
  value: string | undefined,
  maxLength?: number,
): string | null {
  const normalized = normalizeText(value);
  return normalized ? truncateText(normalized, maxLength) : null;
}

function labelFromAxRole(role: string): string {
  const withoutPrefix = role.startsWith("AX") ? role.slice(2) : role;
  return withoutPrefix.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function elementRoleLabel(element: AccessibilityElementSnapshot): string {
  if (element.role === "AXWindow") {
    if (element.subrole === "AXDialog") {
      return "dialog";
    }
    return "standard window";
  }
  if (element.role === "AXWebArea") {
    return formatText(element.roleDescription, 80) ?? "HTML content";
  }
  if (element.role) {
    const label = ROLE_LABELS[element.role];
    if (label) {
      return label;
    }
  }
  if (element.roleDescription) {
    return formatText(element.roleDescription, 80) ?? "element";
  }
  return element.role ? labelFromAxRole(element.role) : "element";
}

function elementAnnotations(element: AccessibilityElementSnapshot): string[] {
  const annotations: string[] = [];
  if (element.valueSettable === true) {
    annotations.push(
      element.valueType ? `settable, ${element.valueType}` : "settable",
    );
  }
  if (element.enabled === false) {
    annotations.push("disabled");
  }
  if (element.selected === true) {
    annotations.push("selected");
  } else if (element.selectable === true) {
    annotations.push("selectable");
  }
  if (element.expanded === true) {
    annotations.push("expanded");
  }
  if (
    element.pressable === true &&
    element.clickableKind === "press" &&
    (element.role === undefined || !PRIMARY_CLICK_ROLE_NAMES.has(element.role))
  ) {
    annotations.push("pressable");
  }
  if (element.pickable === true && element.clickableKind === "pick") {
    annotations.push("pickable");
  }
  if (
    element.mouseClickable === true &&
    element.clickableKind === "mouse" &&
    element.selectable !== true &&
    (element.role === undefined ||
      !PRIMARY_CLICK_ROLE_NAMES.has(element.role)) &&
    element.role !== "AXStaticText" &&
    (element.role === undefined || !GENERIC_WRAPPER_ROLES.has(element.role))
  ) {
    annotations.push("clickable");
  }
  return annotations;
}

function elementPrimaryText(
  element: AccessibilityElementSnapshot,
): string | null {
  return (
    formatText(element.name) ??
    formatText(element.value) ??
    formatText(element.visibleText) ??
    formatText(element.text) ??
    formatText(element.titleElementText) ??
    formatText(element.description) ??
    formatText(element.placeholderValue) ??
    formatText(element.identifier) ??
    formatText(element.url, 240)
  );
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/^AX/, "");
}

function secondaryActions(element: AccessibilityElementSnapshot): string[] {
  return (element.actions ?? [])
    .filter((action) => {
      if (action === "AXPick" && element.clickableKind === "pick") {
        return false;
      }
      if (
        element.role !== undefined &&
        MENU_ROLE_NAMES.has(element.role) &&
        MENU_ACTION_NOISE_NAMES.has(action)
      ) {
        return false;
      }
      return (
        !DEFAULT_ACTION_NAMES.has(action) &&
        !GENERIC_WEB_ACTION_NAMES.has(action)
      );
    })
    .map((action) => {
      return actionLabel(action);
    });
}

function elementDetails(
  element: AccessibilityElementSnapshot,
  primary: string | null,
): string[] {
  const details: string[] = [];
  const description = formatText(element.description);
  if (description && description !== primary) {
    details.push(`Description: ${description}`);
  }
  const value = formatText(element.value);
  if (value && value !== primary) {
    details.push(`Value: ${value}`);
  }
  const visibleText = formatText(element.visibleText);
  if (visibleText && visibleText !== primary) {
    details.push(`Visible Text: ${visibleText}`);
  }
  const text = formatText(element.text);
  if (text && text !== primary) {
    details.push(`Text: ${text}`);
  }
  const titleElementText = formatText(element.titleElementText);
  if (titleElementText && titleElementText !== primary) {
    details.push(`Title Element: ${titleElementText}`);
  }
  const placeholderValue = formatText(element.placeholderValue);
  if (placeholderValue && placeholderValue !== primary) {
    details.push(`Placeholder: ${placeholderValue}`);
  }
  const columnTitles = formatText(element.columnTitles?.join(", "));
  if (columnTitles && columnTitles !== primary) {
    details.push(`Columns: ${columnTitles}`);
  }
  const identifier = formatText(element.identifier, 120);
  if (identifier && identifier !== primary) {
    details.push(`Identifier: ${identifier}`);
  }
  const url = formatText(element.url, 240);
  if (url && url !== primary) {
    details.push(`URL: ${url}`);
  }
  const help = formatText(element.help);
  if (help && help !== primary) {
    details.push(`Help: ${help}`);
  }
  const actions = secondaryActions(element);
  if (actions.length > 0) {
    details.push(`Secondary Actions: ${actions.join(", ")}`);
  }
  return details;
}

function elementIndex(element: AccessibilityElementSnapshot): number {
  return element.index ?? 0;
}

function formatElementLine(
  element: AccessibilityElementSnapshot,
  depth: number,
): string {
  const primary = elementPrimaryText(element);
  const annotations = elementAnnotations(element);
  const details = elementDetails(element, primary);
  let line = `${"\t".repeat(depth)}${elementIndex(element)} ${elementRoleLabel(
    element,
  )}`;
  if (annotations.length > 0) {
    line += ` (${annotations.join(", ")})`;
  }
  if (primary) {
    line += ` ${primary}`;
  }
  if (details.length > 0) {
    line += `${primary ? ", " : " "}${details.join(", ")}`;
  }
  return line;
}

function findElementByIndex(
  elements: readonly AccessibilityElementSnapshot[],
  index: number,
): AccessibilityElementSnapshot | null {
  for (const element of elements) {
    if (element.index === index) {
      return element;
    }
    const child = findElementByIndex(element.children ?? [], index);
    if (child) {
      return child;
    }
  }
  return null;
}

function focusedElementLine(
  snapshot: AccessibilityAppStateSnapshot,
): string | null {
  if (snapshot.focusedElementIndex === undefined) {
    return null;
  }
  const element = findElementByIndex(
    snapshot.elements,
    snapshot.focusedElementIndex,
  );
  if (!element) {
    return `The focused UI element is ${snapshot.focusedElementIndex}.`;
  }
  return `The focused UI element is ${formatElementLine(element, 0)}.`;
}

function formatSpaceIds(spaceIds: readonly number[] | undefined): string {
  return spaceIds && spaceIds.length > 0 ? spaceIds.join(", ") : "unknown";
}

function windowSpaceLine(
  snapshot: AccessibilityAppStateSnapshot,
): string | null {
  if (snapshot.windowOnCurrentSpace !== false) {
    return null;
  }
  const currentSpace =
    snapshot.currentSpaceId !== undefined
      ? snapshot.currentSpaceId.toString()
      : "unknown";
  return `Window is on another macOS Space (current Space ${currentSpace}, window Spaces ${formatSpaceIds(snapshot.windowSpaceIds)}). Screenshot capture can still work, but macOS may expose only a reduced Accessibility tree until the window is moved to the current Space.`;
}

export function renderAccessibilityTree(
  snapshot: AccessibilityAppStateSnapshot,
): string {
  const indexed = indexAccessibilitySnapshot(snapshot).snapshot;
  const appName = indexed.appDisplayName ?? indexed.app;
  const appIdentity = indexed.appPath ?? appName;
  const appDetails = [
    indexed.bundleId ? `bundleID ${indexed.bundleId}` : null,
    indexed.pid !== undefined ? `pid ${indexed.pid}` : null,
  ].filter((part): part is string => {
    return part !== null;
  });
  const lines = [
    "Computer Use state",
    "<app_state>",
    appDetails.length > 0
      ? `App=${appIdentity} (${appDetails.join(", ")})`
      : `App=${appIdentity}`,
  ];
  const windowTitle =
    formatText(indexed.windowTitle) ?? formatText(indexed.elements[0]?.name);
  if (windowTitle) {
    lines.push(`Window: "${windowTitle}", App: ${appName}.`);
  }
  const spaceLine = windowSpaceLine(indexed);
  if (spaceLine) {
    lines.push(spaceLine);
  }

  const visit = (
    element: AccessibilityElementSnapshot,
    depth: number,
  ): void => {
    lines.push(formatElementLine(element, depth));
    for (const child of element.children ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const element of indexed.elements) {
    visit(element, 0);
  }
  const focusedLine = focusedElementLine(indexed);
  if (focusedLine) {
    lines.push("", focusedLine);
  }
  lines.push("</app_state>");
  return lines.join("\n");
}

/**
 * Snapshot fields shared with the server, excluding the raw `elements` tree:
 * only the rendered `appState` representation is consumed downstream (the CLI
 * writes it to a file for the agent), so the structured tree stays local to
 * the host's snapshot store.
 */
function publicAppStateSnapshot(
  snapshot: AccessibilityAppStateSnapshot,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== "elements" && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

interface ComputerUseAppStateMetrics {
  readonly helperDurationMs: number;
  readonly settle: boolean;
  readonly rawNodeCount: number;
  readonly nodeCount: number;
}

function buildComputerUseAppStateResult(
  snapshot: AccessibilityAppStateSnapshot,
  screenshot: ComputerUseAppStateScreenshot,
  metrics: ComputerUseAppStateMetrics,
): Record<string, unknown> {
  const appState = renderAccessibilityTree(snapshot);
  return {
    ...publicAppStateSnapshot(snapshot),
    appState,
    metrics: {
      ...metrics,
      appStateChars: appState.length,
    },
    screenshot: screenshot.dataUrl,
    screenshotMimeType: screenshot.mimeType,
    screenshotSource: screenshot.source,
    screenshotSourceName: screenshot.sourceName,
    screenshotWidth: screenshot.width,
    screenshotHeight: screenshot.height,
    ...(screenshot.sourceBounds
      ? { screenshotSourceBounds: screenshot.sourceBounds }
      : {}),
  };
}

function appStateScreenshotFailure(message: string): ComputerUseCommandFailure {
  return {
    status: "failed",
    error: {
      code: "screen_recording_unavailable",
      message,
    },
  };
}

function nativeAppStateScreenshot(
  snapshot: AccessibilityAppStateSnapshot,
): ComputerUseAppStateScreenshot | ComputerUseCommandFailure {
  if (!snapshot.screenshot || snapshot.screenshot.trim().length === 0) {
    return appStateScreenshotFailure(
      "Native Computer Use app.state did not return a target-window screenshot",
    );
  }
  if (snapshot.screenshotSource !== "window") {
    return appStateScreenshotFailure(
      "Native Computer Use app.state must return a target-window screenshot",
    );
  }
  if (!snapshot.screenshotSourceName) {
    return appStateScreenshotFailure(
      "Native Computer Use app.state did not return a screenshot source name",
    );
  }
  if (
    snapshot.screenshotWidth === undefined ||
    snapshot.screenshotHeight === undefined ||
    snapshot.screenshotWidth <= 0 ||
    snapshot.screenshotHeight <= 0
  ) {
    return appStateScreenshotFailure(
      "Native Computer Use app.state returned invalid screenshot dimensions",
    );
  }
  if (!snapshot.screenshotSourceBounds) {
    return appStateScreenshotFailure(
      "Native Computer Use app.state did not return target-window screenshot bounds",
    );
  }
  return {
    dataUrl: snapshot.screenshot,
    mimeType: snapshot.screenshotMimeType ?? "image/png",
    source: snapshot.screenshotSource,
    sourceName: snapshot.screenshotSourceName,
    width: snapshot.screenshotWidth,
    height: snapshot.screenshotHeight,
    sourceBounds: snapshot.screenshotSourceBounds,
  };
}

async function listApps(
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  const apps = [...(await nativeBackend.listApps())].sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
    if (nameOrder !== 0) {
      return nameOrder;
    }
    return (left.bundleId ?? "").localeCompare(
      right.bundleId ?? "",
      undefined,
      {
        sensitivity: "base",
      },
    );
  });
  return {
    status: "succeeded",
    result: {
      apps,
    },
  };
}

async function getAppState(
  app: string,
  nativeBackend: ComputerUseNativeBackend,
  snapshotStore: ComputerUseSnapshotStore,
  settle = false,
): Promise<ComputerUseCommandExecutionResult> {
  const id = snapshotId();
  const helperStartedAt = Date.now();
  const rawSnapshot = await nativeBackend.getAppState(app, id, settle);
  const helperDurationMs = Date.now() - helperStartedAt;
  const snapshot = normalizeAccessibilitySnapshot(rawSnapshot);
  const indexed = indexAccessibilitySnapshot(snapshot);
  const screenshot = nativeAppStateScreenshot(indexed.snapshot);
  if ("status" in screenshot) {
    return screenshot;
  }
  snapshotStore.set({
    app: indexed.snapshot.app,
    snapshotId: indexed.snapshot.snapshotId,
    elementIdsByIndex: indexed.elementIdsByIndex,
    ...(indexed.focusedElementIndex !== undefined
      ? { focusedElementIndex: indexed.focusedElementIndex }
      : {}),
    ...(indexed.snapshot.windowId !== undefined
      ? { windowId: indexed.snapshot.windowId }
      : {}),
    ...(indexed.snapshot.windowFrame
      ? { windowFrame: indexed.snapshot.windowFrame }
      : {}),
    screenshotWidth: screenshot.width,
    screenshotHeight: screenshot.height,
    screenshotSource: screenshot.source,
    screenshotSourceName: screenshot.sourceName,
    ...(screenshot.sourceBounds
      ? { sourceBounds: screenshot.sourceBounds }
      : {}),
  });
  return {
    status: "succeeded",
    result: buildComputerUseAppStateResult(indexed.snapshot, screenshot, {
      helperDurationMs,
      settle,
      rawNodeCount: countSnapshotElements(rawSnapshot.elements),
      nodeCount: countSnapshotElements(indexed.snapshot.elements),
    }),
  };
}

async function withPostActionAppState(args: {
  readonly app: string;
  readonly actionResult: ComputerUseCommandSuccess;
  readonly nativeBackend: ComputerUseNativeBackend;
  readonly snapshotStore: ComputerUseSnapshotStore;
}): Promise<ComputerUseCommandExecutionResult> {
  const appStateResult = await getAppState(
    args.app,
    args.nativeBackend,
    args.snapshotStore,
    true,
  );
  if (appStateResult.status === "failed") {
    return appStateResult;
  }
  return {
    status: "succeeded",
    result: {
      ...appStateResult.result,
      action: args.actionResult.result,
    },
  };
}

async function executeWriteActionWithPostActionState(args: {
  readonly app: string;
  readonly permissions: ComputerUsePermissionState;
  readonly nativeBackend: ComputerUseNativeBackend;
  readonly snapshotStore: ComputerUseSnapshotStore;
  readonly execute: () => Promise<ComputerUseCommandExecutionResult>;
}): Promise<ComputerUseCommandExecutionResult> {
  const screenRecordingError = requireScreenRecording(args.permissions);
  if (screenRecordingError) {
    return screenRecordingError;
  }

  const actionResult = await args.execute();
  if (actionResult.status === "failed") {
    return actionResult;
  }
  return await withPostActionAppState({
    app: args.app,
    actionResult,
    nativeBackend: args.nativeBackend,
    snapshotStore: args.snapshotStore,
  });
}

async function openApp(
  app: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  const nativeResult = await nativeBackend.openApp(app);
  return {
    status: "succeeded",
    result: {
      app,
      ...nativeResult,
      summary: `Opened ${app}`,
    },
  };
}

function resolveClickSnapshot(args: {
  readonly app: string;
  readonly snapshotId: string | null;
  readonly snapshotStore: ComputerUseSnapshotStore;
}): ComputerUseSnapshotMetadata | ComputerUseCommandFailure {
  if (args.snapshotId) {
    const snapshot = args.snapshotStore.get(args.app, args.snapshotId);
    return (
      snapshot ??
      unsupportedCommand(
        `Snapshot not found for ${args.app}: ${args.snapshotId}`,
      )
    );
  }

  const latest = args.snapshotStore.getLatestForApp(args.app);
  return (
    latest ??
    unsupportedCommand(`No app state snapshot is available for ${args.app}`)
  );
}

function resolveElementTarget(args: {
  readonly app: string;
  readonly elementId: string | null;
  readonly elementIndex: number | null;
  readonly snapshotId: string | null;
  readonly snapshotStore: ComputerUseSnapshotStore;
  readonly commandName: string;
}): ComputerUseElementTarget | ComputerUseCommandFailure {
  if (args.elementId) {
    return { elementId: args.elementId };
  }
  if (args.elementIndex === null) {
    return unsupportedCommand(
      `${args.commandName} requires elementId or elementIndex`,
    );
  }

  const snapshot = resolveClickSnapshot({
    app: args.app,
    snapshotId: args.snapshotId,
    snapshotStore: args.snapshotStore,
  });
  if ("status" in snapshot) {
    return snapshot;
  }
  const elementId = snapshot.elementIdsByIndex?.[args.elementIndex];
  if (!elementId) {
    return unsupportedCommand(
      `Element index ${args.elementIndex.toString()} was not found in snapshot ${snapshot.snapshotId}`,
    );
  }
  return {
    elementId,
    elementIndex: args.elementIndex,
    snapshotId: snapshot.snapshotId,
  };
}

function elementTargetResult(
  target: ComputerUseElementTarget,
): Record<string, unknown> {
  if (target.elementIndex !== undefined) {
    return {
      elementIndex: target.elementIndex,
      ...(target.snapshotId ? { snapshotId: target.snapshotId } : {}),
    };
  }
  return target.elementId ? { elementId: target.elementId } : {};
}

function elementTargetText(target: ComputerUseElementTarget): string {
  return target.elementIndex !== undefined
    ? `elementIndex=${target.elementIndex}`
    : (target.elementId ?? "element");
}

async function clickElement(args: {
  readonly app: string;
  readonly elementId: string | null;
  readonly elementIndex: number | null;
  readonly snapshotId: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly button: ComputerUseMouseButton;
  readonly clickCount: number;
  readonly foregroundRecovery: ComputerUseNativeForegroundRecoveryPolicy;
  readonly nativeBackend: ComputerUseNativeBackend;
  readonly snapshotStore: ComputerUseSnapshotStore;
}): Promise<ComputerUseCommandExecutionResult> {
  if (args.elementId || args.elementIndex !== null) {
    if (args.button !== "left") {
      return unsupportedCommand(
        "element.click with element target only supports the left button; use coordinates for right or middle clicks",
      );
    }
    const target = resolveElementTarget({
      app: args.app,
      elementId: args.elementId,
      elementIndex: args.elementIndex,
      snapshotId: args.snapshotId,
      snapshotStore: args.snapshotStore,
      commandName: "element.click",
    });
    if ("status" in target) {
      return target;
    }
    const nativeResult = await args.nativeBackend.clickElement({
      app: args.app,
      ...(target.elementId ? { elementId: target.elementId } : {}),
      ...(target.elementIndex !== undefined
        ? { elementIndex: target.elementIndex }
        : {}),
      ...(target.snapshotId ? { snapshotId: target.snapshotId } : {}),
      button: args.button,
      clickCount: args.clickCount,
      foregroundRecovery: args.foregroundRecovery,
    });
    return {
      status: "succeeded",
      result: {
        app: args.app,
        ...elementTargetResult(target),
        button: args.button,
        clickCount: args.clickCount,
        ...nativeResult,
        summary: `Clicked ${elementTargetText(target)}`,
      },
    };
  }
  if (args.x !== null && args.y !== null) {
    const snapshot = resolveClickSnapshot(args);
    if ("status" in snapshot) {
      return snapshot;
    }
    const clickPoint = await args.nativeBackend.clickPoint({
      app: args.app,
      snapshotId: snapshot.snapshotId,
      x: args.x,
      y: args.y,
      screenshotSource: snapshot.screenshotSource,
      screenshotWidth: snapshot.screenshotWidth,
      screenshotHeight: snapshot.screenshotHeight,
      ...(snapshot.sourceBounds ? { sourceBounds: snapshot.sourceBounds } : {}),
      ...(snapshot.windowId !== undefined
        ? { windowId: snapshot.windowId }
        : {}),
      ...(snapshot.windowFrame ? { windowFrame: snapshot.windowFrame } : {}),
      button: args.button,
      clickCount: args.clickCount,
      foregroundRecovery: args.foregroundRecovery,
    });
    const { screenX, screenY, ...nativeResult } = clickPoint;
    return {
      status: "succeeded",
      result: {
        app: args.app,
        snapshotId: snapshot.snapshotId,
        x: args.x,
        y: args.y,
        screenX,
        screenY,
        button: args.button,
        clickCount: args.clickCount,
        ...nativeResult,
        summary: `Clicked ${args.x},${args.y}`,
      },
    };
  }
  return unsupportedCommand(
    "element.click requires elementId, elementIndex, or coordinates",
  );
}

async function setElementValue(
  app: string,
  target: ComputerUseElementTarget,
  value: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  const nativeResult = await nativeBackend.setElementValue({
    app,
    ...(target.elementId ? { elementId: target.elementId } : {}),
    ...(target.elementIndex !== undefined
      ? { elementIndex: target.elementIndex }
      : {}),
    ...(target.snapshotId ? { snapshotId: target.snapshotId } : {}),
    value,
  });
  return {
    status: "succeeded",
    result: {
      app,
      ...elementTargetResult(target),
      ...nativeResult,
      summary: `Set ${elementTargetText(target)}`,
    },
  };
}

async function performElementAction(
  app: string,
  target: ComputerUseElementTarget,
  action: string,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  const nativeResult = await nativeBackend.performElementAction({
    app,
    ...(target.elementId ? { elementId: target.elementId } : {}),
    ...(target.elementIndex !== undefined
      ? { elementIndex: target.elementIndex }
      : {}),
    ...(target.snapshotId ? { snapshotId: target.snapshotId } : {}),
    action,
  });
  return {
    status: "succeeded",
    result: {
      app,
      ...elementTargetResult(target),
      action,
      ...nativeResult,
      summary: `Performed ${action}`,
    },
  };
}

async function typeText(
  app: string,
  text: string,
  snapshotId: string | null,
  nativeBackend: ComputerUseNativeBackend,
  foregroundRecovery: ComputerUseNativeForegroundRecoveryPolicy,
): Promise<ComputerUseCommandExecutionResult> {
  const result = await nativeBackend.typeText({
    app,
    ...(snapshotId ? { snapshotId } : {}),
    text,
    foregroundRecovery,
  });
  return {
    status: "succeeded",
    result: {
      app,
      ...result,
      summary: "Typed text",
    },
  };
}

async function pressKey(
  app: string,
  key: string,
  snapshotId: string | null,
  nativeBackend: ComputerUseNativeBackend,
  foregroundRecovery: ComputerUseNativeForegroundRecoveryPolicy,
): Promise<ComputerUseCommandSuccess> {
  const result = await nativeBackend.pressKey({
    app,
    ...(snapshotId ? { snapshotId } : {}),
    key,
    foregroundRecovery,
  });
  const { normalizedKey, ...nativeResult } = result;
  return {
    status: "succeeded",
    result: {
      app,
      key: normalizedKey,
      ...nativeResult,
      summary: `Pressed ${normalizedKey}`,
    },
  };
}

async function scrollElement(
  app: string,
  target: ComputerUseElementTarget,
  direction: string,
  pages: number,
  nativeBackend: ComputerUseNativeBackend,
): Promise<ComputerUseCommandSuccess> {
  const nativeResult = await nativeBackend.scrollElement({
    app,
    ...(target.elementId ? { elementId: target.elementId } : {}),
    ...(target.elementIndex !== undefined
      ? { elementIndex: target.elementIndex }
      : {}),
    ...(target.snapshotId ? { snapshotId: target.snapshotId } : {}),
    direction,
    pages,
  });
  return {
    status: "succeeded",
    result: {
      app,
      ...elementTargetResult(target),
      direction,
      pages,
      ...nativeResult,
      summary: `Scrolled ${elementTargetText(target)}`,
    },
  };
}

export async function executeComputerUseCommand(
  command: ComputerUseCommand,
  permissions: ComputerUsePermissionState,
  dependencies: ComputerUseCommandExecutionDependencies,
): Promise<ComputerUseCommandExecutionResult> {
  const permissionError = requireAccessibility(
    permissions,
    dependencies.platform ?? process.platform,
  );
  if (permissionError) {
    return permissionError;
  }

  try {
    const nativeBackend =
      dependencies.nativeBackend ?? createComputerUseNativeBackend();
    const snapshotStore =
      dependencies.snapshotStore ?? new ComputerUseSnapshotStore();
    const app = payloadString(command.payload, "app");
    if (command.kind === "apps.list") {
      return await listApps(nativeBackend);
    }
    if (!app) {
      return missingField("app");
    }
    if (command.kind === "app.state") {
      const screenRecordingError = requireScreenRecording(permissions);
      if (screenRecordingError) {
        return screenRecordingError;
      }
      return await getAppState(app, nativeBackend, snapshotStore);
    }
    if (command.kind === "app.open") {
      return await executeWriteActionWithPostActionState({
        app,
        permissions,
        nativeBackend,
        snapshotStore,
        execute: async () => {
          return await openApp(app, nativeBackend);
        },
      });
    }
    if (command.kind === "element.click") {
      const x = payloadNumber(command.payload, "x");
      const y = payloadNumber(command.payload, "y");
      const snapshotId = payloadString(command.payload, "snapshotId");
      const elementId = payloadString(command.payload, "elementId");
      const elementIndex = payloadElementIndex(command.payload);
      const foregroundRecovery = payloadForegroundRecoveryPolicy(
        command.payload,
      );
      if (
        !elementId &&
        elementIndex === null &&
        x !== null &&
        y !== null &&
        !snapshotId &&
        !snapshotStore.getLatestForApp(app)
      ) {
        const screenRecordingError = requireScreenRecording(permissions);
        if (screenRecordingError) {
          return screenRecordingError;
        }
        const snapshotResult = await getAppState(
          app,
          nativeBackend,
          snapshotStore,
        );
        if (snapshotResult.status === "failed") {
          return snapshotResult;
        }
      }
      return await executeWriteActionWithPostActionState({
        app,
        permissions,
        nativeBackend,
        snapshotStore,
        execute: async () => {
          return await clickElement({
            app,
            elementId,
            elementIndex,
            snapshotId,
            x,
            y,
            button: payloadMouseButton(command.payload),
            clickCount: payloadClickCount(command.payload),
            foregroundRecovery,
            nativeBackend,
            snapshotStore,
          });
        },
      });
    }
    if (command.kind === "element.scroll") {
      const elementId = payloadString(command.payload, "elementId");
      const elementIndex = payloadElementIndex(command.payload);
      const snapshotId = payloadString(command.payload, "snapshotId");
      const direction = payloadString(command.payload, "direction");
      if (!direction) {
        return missingField("direction");
      }
      const target = resolveElementTarget({
        app,
        elementId,
        elementIndex,
        snapshotId,
        snapshotStore,
        commandName: "element.scroll",
      });
      if ("status" in target) {
        return target;
      }
      return await executeWriteActionWithPostActionState({
        app,
        permissions,
        nativeBackend,
        snapshotStore,
        execute: async () => {
          return await scrollElement(
            app,
            target,
            direction,
            payloadNumber(command.payload, "pages") ?? 1,
            nativeBackend,
          );
        },
      });
    }
    if (command.kind === "element.set_value") {
      const elementId = payloadString(command.payload, "elementId");
      const elementIndex = payloadElementIndex(command.payload);
      const snapshotId = payloadString(command.payload, "snapshotId");
      const value = payloadString(command.payload, "value");
      if (typeof value !== "string" || !value) {
        return missingField("value");
      }
      const target = resolveElementTarget({
        app,
        elementId,
        elementIndex,
        snapshotId,
        snapshotStore,
        commandName: "element.set_value",
      });
      if ("status" in target) {
        return target;
      }
      return await executeWriteActionWithPostActionState({
        app,
        permissions,
        nativeBackend,
        snapshotStore,
        execute: async () => {
          return await setElementValue(app, target, value, nativeBackend);
        },
      });
    }
    if (command.kind === "element.perform_action") {
      const elementId = payloadString(command.payload, "elementId");
      const elementIndex = payloadElementIndex(command.payload);
      const snapshotId = payloadString(command.payload, "snapshotId");
      const action = payloadString(command.payload, "action");
      if (!action) {
        return missingField("action");
      }
      const target = resolveElementTarget({
        app,
        elementId,
        elementIndex,
        snapshotId,
        snapshotStore,
        commandName: "element.perform_action",
      });
      if ("status" in target) {
        return target;
      }
      return await executeWriteActionWithPostActionState({
        app,
        permissions,
        nativeBackend,
        snapshotStore,
        execute: async () => {
          return await performElementAction(app, target, action, nativeBackend);
        },
      });
    }
    if (command.kind === "keyboard.type_text") {
      const text = payloadString(command.payload, "text");
      const snapshotId = payloadString(command.payload, "snapshotId");
      const foregroundRecovery = payloadForegroundRecoveryPolicy(
        command.payload,
      );
      return typeof text === "string" && text.length > 0
        ? await executeWriteActionWithPostActionState({
            app,
            permissions,
            nativeBackend,
            snapshotStore,
            execute: async () => {
              return await typeText(
                app,
                text,
                snapshotId,
                nativeBackend,
                foregroundRecovery,
              );
            },
          })
        : missingField("text");
    }
    if (command.kind === "keyboard.press_key") {
      const key = payloadString(command.payload, "key");
      const snapshotId = payloadString(command.payload, "snapshotId");
      const foregroundRecovery = payloadForegroundRecoveryPolicy(
        command.payload,
      );
      return key
        ? await executeWriteActionWithPostActionState({
            app,
            permissions,
            nativeBackend,
            snapshotStore,
            execute: async () => {
              return await pressKey(
                app,
                key,
                snapshotId,
                nativeBackend,
                foregroundRecovery,
              );
            },
          })
        : missingField("key");
    }
  } catch (error) {
    if (error instanceof UnsupportedComputerUseCommandError) {
      return unsupportedCommand(error.message);
    }
    if (error instanceof ComputerUseNativeHelperError) {
      return {
        status: "failed",
        error: {
          code: error.code,
          message: error.message,
        },
      };
    }
    return {
      status: "failed",
      error: {
        code: "accessibility_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return {
    status: "failed",
    error: {
      code: "unsupported_command",
      message: `Unsupported command: ${command.kind}`,
    },
  };
}
