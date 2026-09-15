import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  type RustConstantValue,
  type RustConstantModuleDoc,
  type RustConstantBinding,
  rustConstantModuleDocs,
  rustConstantRootDoc,
  rustConstantBindings,
} from "./constants";
import {
  type RustDecodePathBinding,
  rustDecodePathBindings,
} from "./decode-paths";
import { type RustRouteBinding, rustRouteBindings } from "./routes";
import { generatePublicDestinationPolicy } from "./public-destination";
import {
  type RustTypeModuleDoc,
  type RustTypeBinding,
  rustTypeModuleDocs,
  rustTypeRootDoc,
  rustTypeBindings,
} from "./types";

const generatedRoutesPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/routes.rs",
    import.meta.url,
  ),
);
const generatedTypesPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/types.rs",
    import.meta.url,
  ),
);
const generatedConstantsPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/constants.rs",
    import.meta.url,
  ),
);
const generatedDecodePathsPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/decode_paths.rs",
    import.meta.url,
  ),
);
const generatedModPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/mod.rs",
    import.meta.url,
  ),
);
const httpMethods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof httpMethods)[number];
export type RustMethodVariant =
  | "Get"
  | "Post"
  | "Put"
  | "Patch"
  | "Delete"
  | "Head"
  | "Options";

export interface NormalizedRouteBinding {
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly pathParams: readonly PathParamBinding[];
  readonly rustMethodVariant: RustMethodVariant;
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
}

interface PathParamBinding {
  readonly routeName: string;
  readonly rustName: string;
}

interface ModuleNode {
  readonly routes: NormalizedRouteBinding[];
  readonly children: Map<string, ModuleNode>;
}

const rustRouteRootDoc = [
  "Generated Rust route bindings for selected `@okouai/api-contracts` routes.",
  "Do not edit by hand; regenerate with `cd turbo && pnpm -F @okouai/api-contracts generate:rust`.",
  "Route descriptions are generated from TypeScript contract summaries.",
] as const;

export interface NormalizedTypeBinding {
  readonly schema: JsonObject;
  readonly direction: "request" | "response";
  readonly rustModulePath: readonly string[];
  readonly rustTypeName: string;
  readonly fieldTypeOverrides: Readonly<Record<string, string>>;
  readonly sensitive: boolean;
  readonly declarationDocs: ReadonlyMap<string, NormalizedTypeDeclarationDoc>;
}

export interface NormalizedConstantBinding {
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
  readonly value: RustConstantValue;
  readonly rustDoc: readonly string[];
}

export interface NormalizedDecodePathBinding {
  readonly node: DecodePathNode;
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
  readonly rustDoc: readonly string[];
}

export type DecodePathNode =
  | { readonly kind: "leaf" }
  | {
      readonly kind: "object";
      readonly fields: readonly DecodePathField[];
    }
  | {
      readonly kind: "sequence";
      readonly item: DecodePathNode;
    }
  | {
      readonly kind: "dynamic-map";
      readonly value: DecodePathNode;
    };

export interface DecodePathField {
  readonly name: string;
  readonly node: DecodePathNode;
}

type FlatDecodePathNode =
  | { readonly kind: "leaf" }
  | {
      readonly kind: "object";
      readonly fieldStart: number;
      readonly fieldLength: number;
    }
  | { readonly kind: "sequence"; readonly item: number }
  | { readonly kind: "dynamic-map"; readonly value: number };

interface FlatDecodePathField {
  readonly name: string;
  readonly node: number;
}

interface FlatDecodePathSchema {
  readonly nodes: readonly FlatDecodePathNode[];
  readonly fields: readonly FlatDecodePathField[];
}

interface TypeModuleNode {
  readonly rustDoc: readonly string[];
  readonly declarations: RustDeclaration[];
  readonly declarationNames: Set<string>;
  readonly children: Map<string, TypeModuleNode>;
}

interface ConstModuleNode {
  readonly rustDoc: readonly string[];
  readonly constants: NormalizedConstantBinding[];
  readonly children: Map<string, ConstModuleNode>;
}

interface DecodePathModuleNode {
  readonly bindings: NormalizedDecodePathBinding[];
  readonly children: Map<string, DecodePathModuleNode>;
}

interface RenderTypeContext {
  readonly label: string;
  readonly moduleIndentWidth: number;
  readonly fieldTypeOverrides: Readonly<Record<string, string>>;
  readonly sensitive: boolean;
  readonly declarationDocs: ReadonlyMap<string, NormalizedTypeDeclarationDoc>;
  readonly declarations: RustDeclaration[];
  readonly declarationNames: Set<string>;
  readonly usedDeclarationDocs: Set<string>;
  readonly usedFieldDocs: Set<string>;
  readonly usedVariantDocs: Set<string>;
}

interface RustDeclaration {
  readonly name: string;
  readonly lines: string[];
}

interface TaggedUnion {
  readonly tag: string;
  readonly variants: readonly TaggedUnionVariant[];
}

interface TaggedUnionVariant {
  readonly value: string;
  readonly properties: JsonObject;
  readonly required: readonly string[];
}

interface NormalizedTypeDeclarationDoc {
  readonly rustDoc: readonly string[];
  readonly fields: ReadonlyMap<string, readonly string[]>;
  readonly variants: ReadonlyMap<string, readonly string[]>;
}

type JsonObject = Record<string, unknown>;

const rustModuleSegmentPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const rustConstNamePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const rustTypeNamePattern = /^[A-Z][A-Za-z0-9]*$/;
const routePathParamPattern = /^[A-Za-z][A-Za-z0-9_]*$/;
// rustfmt expands this function-like attribute before the nominal 100-column
// limit, so generated code must use the same effective width to remain stable.
const rustfmtSingleLineDeriveMaxWidth = 96;
const rustKeywords = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "become",
  "box",
  "break",
  "const",
  "continue",
  "crate",
  "do",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "final",
  "fn",
  "for",
  "gen",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "macro",
  "macro_rules",
  "match",
  "mod",
  "move",
  "mut",
  "override",
  "priv",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "union",
  "unsized",
  "unsafe",
  "use",
  "virtual",
  "where",
  "while",
  "yield",
]);

export function normalizeRouteBindings(
  bindings: readonly RustRouteBinding[],
): readonly NormalizedRouteBinding[] {
  const seenRustNames = new Set<string>();
  const seenRoutes = new Set<string>();
  const normalized: NormalizedRouteBinding[] = [];

  for (const binding of bindings) {
    const label = routeLabel(binding);
    const method = validateHttpMethod(binding.route.method, label);
    const path = validateRoutePath(binding.route.path, label);
    const summary = validateRouteSummary(binding.route.summary, label);
    const pathParams = extractPathParams(path, label);
    const rustModulePath = validateRustModulePath(
      binding.rustModulePath,
      label,
    );
    const rustConstName = validateRustConstName(binding.rustConstName, label);
    const rustName = [...rustModulePath, rustConstName].join("::");
    const routeKey = `${method} ${path}`;

    if (seenRustNames.has(rustName)) {
      throw new Error(`duplicate Rust route binding: ${rustName}`);
    }
    seenRustNames.add(rustName);

    if (seenRoutes.has(routeKey)) {
      throw new Error(`duplicate route binding: ${routeKey}`);
    }
    seenRoutes.add(routeKey);

    normalized.push({
      method,
      path,
      summary,
      pathParams,
      rustMethodVariant: toRustMethodVariant(method),
      rustModulePath,
      rustConstName,
    });
  }

  return [...normalized].sort(compareRouteBindings);
}

export function renderRustRoutes(
  bindings: readonly RustRouteBinding[],
): string {
  const routes = normalizeRouteBindings(bindings);
  const root = buildRouteTree(routes);
  const lines = [
    "// @generated by @okouai/api-contracts.",
    "// Do not edit by hand.",
    "// Regenerate with: cd turbo && pnpm -F @okouai/api-contracts generate:rust",
    "",
    ...renderInnerRustDoc(rustRouteRootDoc),
    "",
    ...renderModuleNode(root, "", []),
  ];

  return `${lines.join("\n")}\n`;
}

export async function generateRustRoutesFile(
  outputPath = generatedRoutesPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRustRoutes(rustRouteBindings));
}

export function normalizeTypeBindings(
  bindings: readonly RustTypeBinding[],
): readonly NormalizedTypeBinding[] {
  const seenRustNames = new Set<string>();
  const normalized: NormalizedTypeBinding[] = [];

  for (const binding of bindings) {
    const label = typeLabel(binding);
    const rustModulePath = validateRustModulePath(
      binding.rustModulePath,
      label,
    );
    const rustTypeName = validateRustTypeName(binding.rustTypeName, label);
    const rustName = [...rustModulePath, rustTypeName].join("::");

    if (seenRustNames.has(rustName)) {
      throw new Error(`duplicate Rust type binding: ${rustName}`);
    }
    seenRustNames.add(rustName);

    normalized.push({
      schema: validateJsonSchema(z.toJSONSchema(binding.schema), label),
      direction: binding.direction,
      rustModulePath,
      rustTypeName,
      fieldTypeOverrides: binding.fieldTypeOverrides ?? {},
      sensitive: binding.sensitive ?? false,
      declarationDocs: normalizeTypeDeclarationDocs(binding, label),
    });
  }

  return [...normalized].sort(compareTypeBindings);
}

export function renderRustTypes(
  bindings: readonly RustTypeBinding[],
  moduleDocs: readonly RustTypeModuleDoc[] = rustTypeModuleDocs,
  rootDoc: readonly string[] = rustTypeRootDoc,
): string {
  const types = normalizeTypeBindings(bindings);
  const root = buildTypeTree(
    types,
    normalizeTypeModuleDocs(moduleDocs),
    validateRustDoc(rootDoc, "Rust type root docs"),
  );
  const lines = [
    "// @generated by @okouai/api-contracts.",
    "// Do not edit by hand.",
    "// Regenerate with: cd turbo && pnpm -F @okouai/api-contracts generate:rust",
    "",
    ...renderInnerRustDoc(root.rustDoc),
    "",
    ...renderTypeModuleNode(root, ""),
  ];

  return `${lines.join("\n")}\n`;
}

export async function generateRustTypesFile(
  outputPath = generatedTypesPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRustTypes(rustTypeBindings));
}

export function normalizeConstantBindings(
  bindings: readonly RustConstantBinding[],
): readonly NormalizedConstantBinding[] {
  const seenRustNames = new Set<string>();
  const normalized: NormalizedConstantBinding[] = [];

  for (const binding of bindings) {
    const label = constantLabel(binding);
    const rustModulePath = validateRustModulePath(
      binding.rustModulePath,
      label,
    );
    const rustConstName = validateRustConstName(binding.rustConstName, label);
    const rustName = [...rustModulePath, rustConstName].join("::");

    if (seenRustNames.has(rustName)) {
      throw new Error(`duplicate Rust constant binding: ${rustName}`);
    }
    seenRustNames.add(rustName);

    normalized.push({
      rustModulePath,
      rustConstName,
      value: validateConstantValue(binding.value, label),
      rustDoc: validateRustDoc(binding.rustDoc, label),
    });
  }

  return [...normalized].sort(compareConstantBindings);
}

export function renderRustConstants(
  bindings: readonly RustConstantBinding[],
  moduleDocs: readonly RustConstantModuleDoc[] = rustConstantModuleDocs,
  rootDoc: readonly string[] = rustConstantRootDoc,
): string {
  const constants = normalizeConstantBindings(bindings);
  const root = buildConstTree(
    constants,
    normalizeConstantModuleDocs(moduleDocs),
    validateRustDoc(rootDoc, "Rust constants root docs"),
  );
  const lines = [
    ...renderInnerRustDoc(root.rustDoc),
    "",
    ...renderConstModuleNode(root, ""),
  ];

  return `${lines.join("\n")}\n`;
}

export async function generateRustConstantsFile(
  outputPath = generatedConstantsPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRustConstants(rustConstantBindings));
}

export function normalizeDecodePathBindings(
  bindings: readonly RustDecodePathBinding[],
): readonly NormalizedDecodePathBinding[] {
  const seenRustNames = new Set<string>();
  const normalized: NormalizedDecodePathBinding[] = [];

  for (const binding of bindings) {
    const label = decodePathLabel(binding);
    const rustModulePath = validateRustModulePath(
      binding.rustModulePath,
      label,
    );
    const rustConstName = validateRustConstName(binding.rustConstName, label);
    const rustName = [...rustModulePath, rustConstName].join("::");

    if (seenRustNames.has(rustName)) {
      throw new Error(`duplicate Rust decode-path binding: ${rustName}`);
    }
    seenRustNames.add(rustName);

    normalized.push({
      node: decodePathNodeForSchema(
        validateJsonSchema(z.toJSONSchema(binding.schema), label),
        label,
      ),
      rustModulePath,
      rustConstName,
      rustDoc: validateRustDoc(binding.rustDoc, label),
    });
  }

  return [...normalized].sort(compareDecodePathBindings);
}

export function renderRustDecodePaths(
  bindings: readonly RustDecodePathBinding[],
): string {
  const normalized = normalizeDecodePathBindings(bindings);
  const root = buildDecodePathTree(normalized);
  const lines = [
    "// @generated by @okouai/api-contracts.",
    "// Do not edit by hand.",
    "// Regenerate with: cd turbo && pnpm -F @okouai/api-contracts generate:rust",
    "",
    "//! Generated response decode-path schemas for selected `@okouai/api-contracts` responses.",
    "//! These schemas classify field names for sanitized Rust JSON decode diagnostics.",
    "",
    ...renderDecodePathModuleNode(root, ""),
  ];

  return `${lines.join("\n")}\n`;
}

export async function generateRustDecodePathsFile(
  outputPath = generatedDecodePathsPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRustDecodePaths(rustDecodePathBindings));
}

export function renderGeneratedMod(): string {
  return [
    "pub mod constants;",
    "pub mod decode_paths;",
    "pub mod public_destination_policy;",
    "pub mod routes;",
    "pub mod types;",
    "",
  ].join("\n");
}

export async function generateRustGeneratedModFile(
  outputPath = generatedModPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderGeneratedMod());
}

export async function generateRustBindings(): Promise<void> {
  await generateRustRoutesFile();
  await generateRustTypesFile();
  await generateRustConstantsFile();
  await generateRustDecodePathsFile();
  await generatePublicDestinationPolicy();
  await generateRustGeneratedModFile();
  // Format the module tree once, including generated deserialization visitors.
  // Generation and the repository's Cargo formatting check must agree.
  execFileSync("rustfmt", ["--edition", "2024", generatedModPath], {
    stdio: "inherit",
  });
}

function routeLabel(binding: RustRouteBinding): string {
  const rustName = [...binding.rustModulePath, binding.rustConstName].join(
    "::",
  );
  return rustName.length > 0 ? rustName : "<unnamed route binding>";
}

function typeLabel(binding: RustTypeBinding): string {
  const rustName = [...binding.rustModulePath, binding.rustTypeName].join("::");
  return rustName.length > 0 ? rustName : "<unnamed type binding>";
}

function constantLabel(binding: RustConstantBinding): string {
  const rustName = [...binding.rustModulePath, binding.rustConstName].join(
    "::",
  );
  return rustName.length > 0 ? rustName : "<unnamed Rust constant binding>";
}

function decodePathLabel(binding: RustDecodePathBinding): string {
  const rustName = [...binding.rustModulePath, binding.rustConstName].join(
    "::",
  );
  return rustName.length > 0 ? rustName : "<unnamed Rust decode-path binding>";
}

function validateHttpMethod(value: unknown, label: string): HttpMethod {
  if (typeof value !== "string") {
    throw new Error(`${label} is missing a string HTTP method`);
  }

  if (!isHttpMethod(value)) {
    throw new Error(`${label} uses unsupported HTTP method: ${value}`);
  }

  return value;
}

function validateRoutePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is missing a string route path`);
  }

  if (!value.startsWith("/")) {
    throw new Error(`${label} route path must start with '/': ${value}`);
  }

  return value;
}

function validateRouteSummary(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is missing route summary`);
  }

  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} has multiline route summary`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is missing route summary`);
  }

  return trimmed;
}

function extractPathParams(
  path: string,
  label: string,
): readonly PathParamBinding[] {
  const seenRouteNames = new Set<string>();
  const seenRustNames = new Set<string>();
  const params: PathParamBinding[] = [];

  for (const segment of path.split("/")) {
    if (!segment.includes(":")) {
      continue;
    }

    if (!segment.startsWith(":")) {
      throw new Error(`${label} uses unsupported route param segment: ${path}`);
    }

    const routeName = segment.slice(1);
    if (!routePathParamPattern.test(routeName)) {
      throw new Error(`${label} has invalid route param name: ${routeName}`);
    }

    const rustName = toRustParamName(routeName);
    if (seenRouteNames.has(routeName)) {
      throw new Error(`${label} has duplicate route param: ${routeName}`);
    }
    if (seenRustNames.has(rustName)) {
      throw new Error(`${label} has duplicate Rust route param: ${rustName}`);
    }

    seenRouteNames.add(routeName);
    seenRustNames.add(rustName);
    params.push({ routeName, rustName });
  }

  return params;
}

function toRustParamName(routeName: string): string {
  const snake = routeName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

  return rustKeywords.has(snake) ? `${snake}_` : snake;
}

function validateRustModulePath(
  segments: readonly string[],
  label: string,
): readonly string[] {
  if (segments.length === 0) {
    throw new Error(`${label} must declare at least one Rust module segment`);
  }

  return segments.map((segment) => {
    if (!rustModuleSegmentPattern.test(segment)) {
      throw new Error(`${label} has invalid Rust module segment: ${segment}`);
    }

    return segment;
  });
}

function validateRustConstName(value: string, label: string): string {
  if (!rustConstNamePattern.test(value)) {
    throw new Error(`${label} has invalid Rust const name: ${value}`);
  }

  return value;
}

function validateRustTypeName(value: string, label: string): string {
  if (!rustTypeNamePattern.test(value)) {
    throw new Error(`${label} has invalid Rust type name: ${value}`);
  }

  return value;
}

function validateConstantValue(
  value: unknown,
  label: string,
): RustConstantValue {
  if (!isRecord(value)) {
    throw new Error(`${label} is missing a supported Rust constant value`);
  }

  const kind = value["kind"];
  const rawValue = value["value"];
  switch (kind) {
    case "string":
      if (typeof rawValue !== "string") {
        throw new Error(`${label} is missing a string constant value`);
      }
      return { kind, value: rawValue };
    case "u32":
      if (
        typeof rawValue !== "number" ||
        !Number.isSafeInteger(rawValue) ||
        rawValue < 0 ||
        rawValue > 0xffff_ffff
      ) {
        throw new Error(`${label} has invalid u32 constant value`);
      }
      return { kind, value: rawValue };
    case "u64":
      if (
        typeof rawValue !== "number" ||
        !Number.isSafeInteger(rawValue) ||
        rawValue < 0
      ) {
        throw new Error(`${label} has invalid u64 constant value`);
      }
      return { kind, value: rawValue };
    default:
      throw new Error(`${label} uses unsupported Rust constant kind`);
  }
}

function validateRustDoc(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} is missing Rust doc lines`);
  }

  return value.map((line) => {
    if (typeof line !== "string" || line.length === 0) {
      throw new Error(`${label} has empty Rust doc line`);
    }
    if (line.includes("\n") || line.includes("\r")) {
      throw new Error(`${label} has multiline Rust doc line`);
    }

    return line;
  });
}

function isHttpMethod(value: string): value is HttpMethod {
  return httpMethods.some((method) => {
    return method === value;
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function toRustMethodVariant(method: HttpMethod): RustMethodVariant {
  switch (method) {
    case "GET":
      return "Get";
    case "POST":
      return "Post";
    case "PUT":
      return "Put";
    case "PATCH":
      return "Patch";
    case "DELETE":
      return "Delete";
    case "HEAD":
      return "Head";
    case "OPTIONS":
      return "Options";
  }
}

function compareRouteBindings(
  left: NormalizedRouteBinding,
  right: NormalizedRouteBinding,
): number {
  return compareAscii(rustRouteName(left), rustRouteName(right));
}

function rustRouteName(binding: NormalizedRouteBinding): string {
  return [...binding.rustModulePath, binding.rustConstName].join("::");
}

function buildRouteTree(routes: readonly NormalizedRouteBinding[]): ModuleNode {
  const root = createModuleNode();

  for (const route of routes) {
    let node = root;

    for (const segment of route.rustModulePath) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createModuleNode();
        node.children.set(segment, child);
      }
      node = child;
    }

    node.routes.push(route);
  }

  return root;
}

function createModuleNode(): ModuleNode {
  return {
    routes: [],
    children: new Map(),
  };
}

function compareTypeBindings(
  left: NormalizedTypeBinding,
  right: NormalizedTypeBinding,
): number {
  return compareAscii(rustTypeName(left), rustTypeName(right));
}

function rustTypeName(binding: NormalizedTypeBinding): string {
  return [...binding.rustModulePath, binding.rustTypeName].join("::");
}

function compareConstantBindings(
  left: NormalizedConstantBinding,
  right: NormalizedConstantBinding,
): number {
  return compareAscii(rustConstantName(left), rustConstantName(right));
}

function rustConstantName(binding: NormalizedConstantBinding): string {
  return [...binding.rustModulePath, binding.rustConstName].join("::");
}

function compareDecodePathBindings(
  left: NormalizedDecodePathBinding,
  right: NormalizedDecodePathBinding,
): number {
  return compareAscii(rustDecodePathName(left), rustDecodePathName(right));
}

function rustDecodePathName(binding: NormalizedDecodePathBinding): string {
  return [...binding.rustModulePath, binding.rustConstName].join("::");
}

function normalizeConstantModuleDocs(
  docs: readonly RustConstantModuleDoc[],
): ReadonlyMap<string, readonly string[]> {
  const moduleDocs = new Map<string, readonly string[]>();

  for (const doc of docs) {
    const label = constantModuleDocLabel(doc);
    const rustModulePath = validateRustModulePath(doc.rustModulePath, label);
    const rustName = rustModuleKey(rustModulePath);

    if (moduleDocs.has(rustName)) {
      throw new Error(`duplicate Rust constant module docs: ${rustName}`);
    }

    moduleDocs.set(rustName, validateRustDoc(doc.rustDoc, label));
  }

  return moduleDocs;
}

function constantModuleDocLabel(doc: RustConstantModuleDoc): string {
  const rustName = rustModuleKey(doc.rustModulePath);
  return rustName.length > 0
    ? `${rustName} module docs`
    : "<unnamed Rust constant module docs>";
}

function normalizeTypeModuleDocs(
  docs: readonly RustTypeModuleDoc[],
): ReadonlyMap<string, readonly string[]> {
  const moduleDocs = new Map<string, readonly string[]>();

  for (const doc of docs) {
    const label = typeModuleDocLabel(doc);
    const rustModulePath = validateRustModulePath(doc.rustModulePath, label);
    const rustName = rustModuleKey(rustModulePath);

    if (moduleDocs.has(rustName)) {
      throw new Error(`duplicate Rust type module docs: ${rustName}`);
    }

    moduleDocs.set(rustName, validateRustDoc(doc.rustDoc, label));
  }

  return moduleDocs;
}

function typeModuleDocLabel(doc: RustTypeModuleDoc): string {
  const rustName = rustModuleKey(doc.rustModulePath);
  return rustName.length > 0
    ? `${rustName} module docs`
    : "<unnamed type module docs>";
}

function rustModuleKey(path: readonly string[]): string {
  return path.join("::");
}

function normalizeTypeDeclarationDocs(
  binding: RustTypeBinding,
  label: string,
): ReadonlyMap<string, NormalizedTypeDeclarationDoc> {
  if (binding.declarations.length === 0) {
    throw new Error(`${label} is missing Rust type declaration docs`);
  }

  const declarationDocs = new Map<string, NormalizedTypeDeclarationDoc>();

  for (const declaration of binding.declarations) {
    const rustTypeName = validateRustTypeName(
      declaration.rustTypeName,
      `${label} declaration docs`,
    );
    if (declarationDocs.has(rustTypeName)) {
      throw new Error(
        `${label} has duplicate Rust type declaration docs: ${rustTypeName}`,
      );
    }

    declarationDocs.set(rustTypeName, {
      rustDoc: validateRustDoc(
        declaration.rustDoc,
        `${label}.${rustTypeName} docs`,
      ),
      fields: normalizeRustDocRecord(
        declaration.fields ?? {},
        `${label}.${rustTypeName} field docs`,
      ),
      variants: normalizeRustDocRecord(
        declaration.variants ?? {},
        `${label}.${rustTypeName} variant docs`,
      ),
    });
  }

  return declarationDocs;
}

function normalizeRustDocRecord(
  docs: Readonly<Record<string, readonly string[]>>,
  label: string,
): ReadonlyMap<string, readonly string[]> {
  const normalized = new Map<string, readonly string[]>();

  for (const [name, rustDoc] of Object.entries(docs)) {
    if (name.length === 0) {
      throw new Error(`${label} has empty Rust doc key`);
    }
    normalized.set(name, validateRustDoc(rustDoc, `${label}.${name}`));
  }

  return normalized;
}

function buildTypeTree(
  types: readonly NormalizedTypeBinding[],
  moduleDocs: ReadonlyMap<string, readonly string[]>,
  rootDoc: readonly string[],
): TypeModuleNode {
  const root = createTypeModuleNode(rootDoc);
  const usedModuleDocs = new Set<string>();

  for (const type of types) {
    let node = root;
    const modulePath: string[] = [];

    for (const segment of type.rustModulePath) {
      modulePath.push(segment);
      const moduleKey = rustModuleKey(modulePath);
      usedModuleDocs.add(moduleKey);
      let child = node.children.get(segment);
      if (child === undefined) {
        const moduleDoc = moduleDocs.get(moduleKey);
        if (moduleDoc === undefined) {
          throw new Error(`missing Rust docs for type module ${moduleKey}`);
        }
        child = createTypeModuleNode(moduleDoc);
        node.children.set(segment, child);
      }
      node = child;
    }

    for (const declaration of renderTypeBinding(type)) {
      if (node.declarationNames.has(declaration.name)) {
        throw new Error(
          `${rustTypeName(type)} generates duplicate Rust type name ${declaration.name} in module ${type.rustModulePath.join("::")}`,
        );
      }
      node.declarationNames.add(declaration.name);
      node.declarations.push(declaration);
    }
  }

  for (const moduleKey of moduleDocs.keys()) {
    if (!usedModuleDocs.has(moduleKey)) {
      throw new Error(`unused Rust docs for type module ${moduleKey}`);
    }
  }

  return root;
}

function createTypeModuleNode(rustDoc: readonly string[]): TypeModuleNode {
  return {
    rustDoc,
    declarations: [],
    declarationNames: new Set(),
    children: new Map(),
  };
}

function buildConstTree(
  constants: readonly NormalizedConstantBinding[],
  moduleDocs: ReadonlyMap<string, readonly string[]>,
  rootDoc: readonly string[],
): ConstModuleNode {
  const root = createConstModuleNode(rootDoc);

  for (const constant of constants) {
    let node = root;
    const modulePath: string[] = [];

    for (const segment of constant.rustModulePath) {
      modulePath.push(segment);
      const moduleKey = rustModuleKey(modulePath);
      let child = node.children.get(segment);
      if (child === undefined) {
        const moduleDoc = moduleDocs.get(moduleKey);
        if (moduleDoc === undefined) {
          throw new Error(`missing Rust docs for constant module ${moduleKey}`);
        }
        child = createConstModuleNode(moduleDoc);
        node.children.set(segment, child);
      }
      node = child;
    }

    node.constants.push(constant);
  }

  return root;
}

function createConstModuleNode(rustDoc: readonly string[]): ConstModuleNode {
  return {
    rustDoc,
    constants: [],
    children: new Map(),
  };
}

function buildDecodePathTree(
  bindings: readonly NormalizedDecodePathBinding[],
): DecodePathModuleNode {
  const root = createDecodePathModuleNode();

  for (const binding of bindings) {
    let node = root;
    for (const segment of binding.rustModulePath) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createDecodePathModuleNode();
        node.children.set(segment, child);
      }
      node = child;
    }
    node.bindings.push(binding);
  }

  return root;
}

function createDecodePathModuleNode(): DecodePathModuleNode {
  return {
    bindings: [],
    children: new Map(),
  };
}

function renderDecodePathModuleNode(
  node: DecodePathModuleNode,
  indent: string,
  modulePath: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  const bindings = [...node.bindings].sort(compareDecodePathBindings);
  const children = [...node.children.entries()].sort(
    ([leftName], [rightName]) => {
      return compareAscii(leftName, rightName);
    },
  );

  for (const binding of bindings) {
    appendBlankLineIfNeeded(lines);
    lines.push(...renderDecodePathBinding(binding, indent));
  }

  for (const [moduleName, child] of children) {
    appendBlankLineIfNeeded(lines);
    const childPath = [...modulePath, moduleName];
    lines.push(
      `${indent}/// Generated decode-path schemas under \`${childPath.join("::")}\`.`,
    );
    lines.push(`${indent}pub mod ${moduleName} {`);
    lines.push(
      ...renderDecodePathModuleNode(child, `${indent}    `, childPath),
    );
    lines.push(`${indent}}`);
  }

  return lines;
}

function renderDecodePathBinding(
  binding: NormalizedDecodePathBinding,
  indent: string,
): string[] {
  const flat = flattenDecodePathSchema(binding.node);
  const lines = [
    `${indent}const NODES: &[crate::decode_path::DecodePathNode] = &[`,
  ];
  for (const node of flat.nodes) {
    lines.push(`${indent}    ${renderFlatDecodePathNode(node)},`);
  }
  lines.push(`${indent}];`);
  lines.push("");
  const fieldExpressions = flat.fields.map((field) => {
    return `crate::decode_path::DecodePathField::new(${rustStringLiteral(field.name)}, ${field.node})`;
  });
  if (fieldExpressions.length <= 1) {
    const fieldsExpression = `&[${fieldExpressions.join(", ")}]`;
    const fieldsDeclaration = `${indent}const FIELDS: &[crate::decode_path::DecodePathField] = ${fieldsExpression};`;
    if (fieldsDeclaration.length <= 100) {
      lines.push(fieldsDeclaration);
    } else {
      lines.push(
        `${indent}const FIELDS: &[crate::decode_path::DecodePathField] =`,
        `${indent}    ${fieldsExpression};`,
      );
    }
  } else {
    lines.push(
      `${indent}const FIELDS: &[crate::decode_path::DecodePathField] = &[`,
    );
    for (const fieldExpression of fieldExpressions) {
      lines.push(`${indent}    ${fieldExpression},`);
    }
    lines.push(`${indent}];`);
  }
  lines.push("");
  lines.push(...renderOuterRustDoc(binding.rustDoc, indent));
  const responseDeclaration = `${indent}pub static ${binding.rustConstName}: crate::DecodePathSchema = crate::DecodePathSchema::new(NODES, FIELDS);`;
  if (responseDeclaration.length <= 100) {
    lines.push(responseDeclaration);
  } else {
    lines.push(
      `${indent}pub static ${binding.rustConstName}: crate::DecodePathSchema =`,
      `${indent}    crate::DecodePathSchema::new(NODES, FIELDS);`,
    );
  }
  return lines;
}

function flattenDecodePathSchema(root: DecodePathNode): FlatDecodePathSchema {
  const nodes: FlatDecodePathNode[] = [];
  const fields: FlatDecodePathField[] = [];

  function addNode(node: DecodePathNode): number {
    const nodeIndex = nodes.length;
    nodes.push({ kind: "leaf" });

    switch (node.kind) {
      case "leaf":
        break;
      case "sequence": {
        const item = addNode(node.item);
        nodes[nodeIndex] = { kind: "sequence", item };
        break;
      }
      case "dynamic-map": {
        const value = addNode(node.value);
        nodes[nodeIndex] = { kind: "dynamic-map", value };
        break;
      }
      case "object": {
        const objectFields = node.fields.map((field) => {
          return { name: field.name, node: addNode(field.node) };
        });
        const fieldStart = fields.length;
        fields.push(...objectFields);
        nodes[nodeIndex] = {
          kind: "object",
          fieldStart,
          fieldLength: objectFields.length,
        };
        break;
      }
    }

    return nodeIndex;
  }

  addNode(root);
  return { nodes, fields };
}

function renderFlatDecodePathNode(node: FlatDecodePathNode): string {
  switch (node.kind) {
    case "leaf":
      return "crate::decode_path::DecodePathNode::Leaf";
    case "sequence":
      return `crate::decode_path::DecodePathNode::Sequence(${node.item})`;
    case "dynamic-map":
      return `crate::decode_path::DecodePathNode::DynamicMap(${node.value})`;
    case "object":
      return `crate::decode_path::DecodePathNode::Object(${node.fieldStart}, ${node.fieldLength})`;
  }
}

function renderConstModuleNode(
  node: ConstModuleNode,
  indent: string,
): string[] {
  const lines: string[] = [];
  const constants = [...node.constants].sort(compareConstantBindings);
  const children = [...node.children.entries()].sort(
    ([leftName], [rightName]) => {
      return compareAscii(leftName, rightName);
    },
  );

  for (const constant of constants) {
    appendBlankLineIfNeeded(lines);
    lines.push(...renderConstant(constant, indent));
  }

  for (const [moduleName, child] of children) {
    appendBlankLineIfNeeded(lines);
    lines.push(...renderOuterRustDoc(child.rustDoc, indent));
    lines.push(`${indent}pub mod ${moduleName} {`);
    lines.push(...renderConstModuleNode(child, `${indent}    `));
    lines.push(`${indent}}`);
  }

  return lines;
}

function renderConstant(
  constant: NormalizedConstantBinding,
  indent: string,
): string[] {
  switch (constant.value.kind) {
    case "string":
      return renderStringConstant(constant, indent, constant.value.value);
    case "u32":
      return renderUnsignedIntegerConstant(
        constant,
        indent,
        constant.value.value,
        "u32",
      );
    case "u64":
      return renderUnsignedIntegerConstant(
        constant,
        indent,
        constant.value.value,
        "u64",
      );
  }
}

function renderStringConstant(
  constant: NormalizedConstantBinding,
  indent: string,
  value: string,
): string[] {
  const literal = rustStringLiteral(value);
  const singleLine = `${indent}pub const ${constant.rustConstName}: &str = ${literal};`;
  const splitValueLine = `${indent}    ${literal};`;
  if (singleLine.length <= 100 || splitValueLine.length > 100) {
    return [...renderOuterRustDoc(constant.rustDoc, indent), singleLine];
  }

  return [
    ...renderOuterRustDoc(constant.rustDoc, indent),
    `${indent}pub const ${constant.rustConstName}: &str =`,
    splitValueLine,
  ];
}

function renderUnsignedIntegerConstant(
  constant: NormalizedConstantBinding,
  indent: string,
  value: number,
  rustType: "u32" | "u64",
): string[] {
  return [
    ...renderOuterRustDoc(constant.rustDoc, indent),
    `${indent}pub const ${constant.rustConstName}: ${rustType} = ${value};`,
  ];
}

function renderInnerRustDoc(lines: readonly string[]): string[] {
  return lines.map((line) => {
    return `//! ${line}`;
  });
}

function renderOuterRustDoc(
  lines: readonly string[],
  indent: string,
): string[] {
  return lines.map((line) => {
    return `${indent}/// ${line}`;
  });
}

function renderTypeModuleNode(node: TypeModuleNode, indent: string): string[] {
  const lines: string[] = [];
  const children = [...node.children.entries()].sort(
    ([leftName], [rightName]) => {
      return compareAscii(leftName, rightName);
    },
  );

  for (const declaration of node.declarations) {
    appendBlankLineIfNeeded(lines);
    lines.push(
      ...declaration.lines.map((line) => {
        return line.length === 0 ? "" : `${indent}${line}`;
      }),
    );
  }

  for (const [moduleName, child] of children) {
    appendBlankLineIfNeeded(lines);
    lines.push(...renderOuterRustDoc(child.rustDoc, indent));
    lines.push(`${indent}pub mod ${moduleName} {`);
    lines.push(...renderTypeModuleNode(child, `${indent}    `));
    lines.push(`${indent}}`);
  }

  return lines;
}

function renderTypeBinding(
  binding: NormalizedTypeBinding,
): readonly RustDeclaration[] {
  const declarations: RustDeclaration[] = [];
  const context: RenderTypeContext = {
    label: rustTypeName(binding),
    moduleIndentWidth: binding.rustModulePath.length * 4,
    fieldTypeOverrides: binding.fieldTypeOverrides,
    sensitive: binding.sensitive,
    declarationDocs: binding.declarationDocs,
    declarations,
    declarationNames: new Set(),
    usedDeclarationDocs: new Set(),
    usedFieldDocs: new Set(),
    usedVariantDocs: new Set(),
  };
  const rootType = rustTypeForSchema(
    binding.schema,
    binding.rustTypeName,
    context,
  );
  if (rootType !== binding.rustTypeName) {
    throw new Error(
      `${context.label} must render as ${binding.rustTypeName}, got ${rootType}`,
    );
  }
  validateTypeDocsConsumed(context);

  return declarations;
}

function validateTypeDocsConsumed(context: RenderTypeContext): void {
  for (const [typeName, declarationDoc] of context.declarationDocs) {
    if (!context.usedDeclarationDocs.has(typeName)) {
      throw new Error(
        `${context.label}.${typeName} has Rust docs but did not generate a declaration`,
      );
    }

    for (const fieldName of declarationDoc.fields.keys()) {
      if (!context.usedFieldDocs.has(typeDocMemberKey(typeName, fieldName))) {
        throw new Error(
          `${context.label}.${typeName}.${fieldName} has Rust docs but did not generate a field`,
        );
      }
    }

    for (const value of declarationDoc.variants.keys()) {
      if (!context.usedVariantDocs.has(typeDocMemberKey(typeName, value))) {
        throw new Error(
          `${context.label}.${typeName}.${value} has Rust docs but did not generate a variant`,
        );
      }
    }
  }
}

function typeDeclarationDoc(
  context: RenderTypeContext,
  typeName: string,
): NormalizedTypeDeclarationDoc {
  const declarationDoc = context.declarationDocs.get(typeName);
  if (declarationDoc === undefined) {
    throw new Error(`${context.label}.${typeName} is missing Rust docs`);
  }

  context.usedDeclarationDocs.add(typeName);
  return declarationDoc;
}

function typeFieldDoc(
  context: RenderTypeContext,
  typeName: string,
  wireName: string,
  declarationDoc: NormalizedTypeDeclarationDoc,
): readonly string[] {
  const rustDoc = declarationDoc.fields.get(wireName);
  if (rustDoc === undefined) {
    throw new Error(
      `${context.label}.${typeName}.${wireName} is missing Rust field docs`,
    );
  }

  context.usedFieldDocs.add(typeDocMemberKey(typeName, wireName));
  return rustDoc;
}

function typeVariantDoc(
  context: RenderTypeContext,
  typeName: string,
  value: string,
  declarationDoc: NormalizedTypeDeclarationDoc,
): readonly string[] {
  const rustDoc = declarationDoc.variants.get(value);
  if (rustDoc === undefined) {
    throw new Error(
      `${context.label}.${typeName}.${value} is missing Rust variant docs`,
    );
  }

  context.usedVariantDocs.add(typeDocMemberKey(typeName, value));
  return rustDoc;
}

function typeDocMemberKey(typeName: string, memberName: string): string {
  return `${typeName}.${memberName}`;
}

function rustTypeForSchema(
  schema: JsonObject,
  typeName: string,
  context: RenderTypeContext,
): string {
  const nullable = unwrapNullable(schema, context.label);
  if (nullable !== null) {
    return `Option<${rustTypeForSchema(nullable, typeName, context)}>`;
  }

  const taggedUnion = getTaggedUnion(schema, context.label);
  if (taggedUnion !== null) {
    return renderTaggedEnum(taggedUnion, typeName, context);
  }

  const enumValues = getStringArray(schema.enum);
  if (enumValues !== null) {
    return renderStringEnum(enumValues, typeName, context);
  }

  if ("const" in schema) {
    return rustTypeForConst(schema, context.label);
  }

  const type = getJsonSchemaType(schema, context.label);
  switch (type) {
    case "object":
      return rustTypeForObject(schema, typeName, context);
    case "array":
      return `Vec<${rustTypeForArrayItem(schema, typeName, context)}>`;
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "integer":
      return rustIntegerType(schema);
    case "number":
      return "f64";
    case "null":
      throw new Error(`${context.label} uses unsupported bare null schema`);
    default:
      throw new Error(
        `${context.label} uses unsupported JSON schema type: ${type}`,
      );
  }
}

function rustTypeForObject(
  schema: JsonObject,
  typeName: string,
  context: RenderTypeContext,
): string {
  const properties = getOptionalObject(schema.properties);
  const additionalProperties = schema.additionalProperties;

  if (properties === null || Object.keys(properties).length === 0) {
    if (isJsonObject(additionalProperties)) {
      if (Object.keys(additionalProperties).length === 0) {
        throw new Error(
          `${context.label}.${typeName} uses unsupported untyped additionalProperties`,
        );
      }
      return `std::collections::BTreeMap<String, ${rustTypeForSchema(
        additionalProperties,
        `${typeName}Value`,
        context,
      )}>`;
    }
  }

  if (
    isJsonObject(additionalProperties) &&
    Object.keys(additionalProperties).length > 0
  ) {
    throw new Error(
      `${context.label}.${typeName} mixes fixed properties with additionalProperties`,
    );
  }
  if (additionalProperties === true) {
    throw new Error(
      `${context.label}.${typeName} uses unsupported passthrough object schema`,
    );
  }
  if (
    isJsonObject(additionalProperties) &&
    Object.keys(additionalProperties).length === 0
  ) {
    throw new Error(
      `${context.label}.${typeName} uses unsupported untyped additionalProperties`,
    );
  }

  return renderStruct(properties ?? {}, schema.required, typeName, context);
}

function rustTypeForArrayItem(
  schema: JsonObject,
  typeName: string,
  context: RenderTypeContext,
): string {
  if (!isJsonObject(schema.items)) {
    throw new Error(`${context.label}.${typeName} array is missing items`);
  }

  return rustTypeForSchema(schema.items, typeName, context);
}

function rustTypeForConst(schema: JsonObject, label: string): string {
  const value = schema.const;
  switch (typeof value) {
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? rustIntegerType(schema) : "f64";
    default:
      throw new Error(`${label} uses unsupported const value`);
  }
}

function rustIntegerType(schema: JsonObject): "i64" | "u64" {
  return typeof schema.minimum === "number" && schema.minimum >= 0
    ? "u64"
    : "i64";
}

function renderStruct(
  properties: JsonObject,
  requiredValue: unknown,
  typeName: string,
  context: RenderTypeContext,
): string {
  if (context.declarationNames.has(typeName)) {
    throw new Error(
      `${context.label} has duplicate Rust type name: ${typeName}`,
    );
  }
  context.declarationNames.add(typeName);
  const declarationDoc = typeDeclarationDoc(context, typeName);

  const required = new Set(getStringArray(requiredValue) ?? []);
  const seenRustFields = new Map<string, string>();
  const lines = [
    ...renderOuterRustDoc(declarationDoc.rustDoc, ""),
    context.sensitive
      ? "#[derive(serde::Deserialize)]"
      : "#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]",
    context.sensitive
      ? '#[serde(rename_all = "camelCase", deny_unknown_fields)]'
      : '#[serde(rename_all = "camelCase")]',
    `pub struct ${typeName} {`,
  ];

  for (const [wireName, rawPropertySchema] of Object.entries(properties)) {
    if (!isJsonObject(rawPropertySchema)) {
      throw new Error(
        `${context.label}.${typeName}.${wireName} is not an object schema`,
      );
    }

    const rustName = toRustFieldName(wireName);
    const previousWireName = seenRustFields.get(rustName);
    if (previousWireName !== undefined) {
      throw new Error(
        `${context.label}.${typeName} maps both ${previousWireName} and ${wireName} to Rust field ${rustName}`,
      );
    }
    seenRustFields.set(rustName, wireName);

    const optional = !required.has(wireName);
    const override = context.fieldTypeOverrides[wireName];
    const rawType =
      override ??
      rustTypeForSchema(
        rawPropertySchema,
        nestedTypeNameForField(typeName, wireName, rawPropertySchema),
        context,
      );
    const rustType =
      optional && !isOptionType(rawType) ? `Option<${rawType}>` : rawType;
    const attributes = serdeFieldAttributes({
      wireName,
      rustName,
      optional,
    });
    lines.push(
      ...renderOuterRustDoc(
        typeFieldDoc(context, typeName, wireName, declarationDoc),
        "    ",
      ),
    );

    for (const attribute of attributes) {
      lines.push(`    ${attribute}`);
    }
    lines.push(...renderStructField(rustName, rustType, context));
  }

  lines.push("}");
  context.declarations.push({
    name: typeName,
    lines,
  });

  return typeName;
}

function renderStructField(
  rustName: string,
  rustType: string,
  context: RenderTypeContext,
  isPublic: boolean = true,
): string[] {
  const indent = "    ";
  const visibility = isPublic ? "pub " : "";
  const singleLine = `${indent}${visibility}${rustName}: ${rustType},`;
  if (context.moduleIndentWidth + singleLine.length <= 100) {
    return [singleLine];
  }

  if (rustType.startsWith("Option<") && rustType.endsWith(">")) {
    const innerType = rustType.slice("Option<".length, -1);
    const compactOption = `${indent}    Option<${innerType}>,`;
    if (context.moduleIndentWidth + compactOption.length <= 100) {
      return [`${indent}${visibility}${rustName}:`, compactOption];
    }
    return [
      `${indent}${visibility}${rustName}: Option<`,
      `${indent}    ${innerType},`,
      `${indent}>,`,
    ];
  }

  return [`${indent}${visibility}${rustName}:`, `${indent}    ${rustType},`];
}

function renderStringEnum(
  values: readonly string[],
  typeName: string,
  context: RenderTypeContext,
): string {
  if (context.declarationNames.has(typeName)) {
    throw new Error(
      `${context.label} has duplicate Rust type name: ${typeName}`,
    );
  }
  context.declarationNames.add(typeName);
  const declarationDoc = typeDeclarationDoc(context, typeName);

  const seenVariants = new Set<string>();
  const derive =
    "#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]";
  const lines = [
    ...renderOuterRustDoc(declarationDoc.rustDoc, ""),
    ...(context.moduleIndentWidth + derive.length <=
    rustfmtSingleLineDeriveMaxWidth
      ? [derive]
      : [
          "#[derive(",
          "    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize,",
          ")]",
        ]),
    `pub enum ${typeName} {`,
  ];

  for (const value of values) {
    const variant = toRustVariantName(value);
    if (seenVariants.has(variant)) {
      throw new Error(
        `${context.label}.${typeName} has duplicate Rust enum variant: ${variant}`,
      );
    }
    seenVariants.add(variant);
    lines.push(
      ...renderOuterRustDoc(
        typeVariantDoc(context, typeName, value, declarationDoc),
        "    ",
      ),
    );
    lines.push(`    #[serde(rename = ${rustStringLiteral(value)})]`);
    lines.push(`    ${variant},`);
  }

  lines.push("}");
  context.declarations.push({
    name: typeName,
    lines,
  });

  return typeName;
}

function renderSensitiveTaggedEnum(
  union: TaggedUnion,
  typeName: string,
  context: RenderTypeContext,
): string {
  if (context.declarationNames.has(typeName)) {
    throw new Error(
      `${context.label} has duplicate Rust type name: ${typeName}`,
    );
  }
  context.declarationNames.add(typeName);
  const doc = typeDeclarationDoc(context, typeName);
  const fields = new Map<
    string,
    { rustName: string; rustType: string; schema: JsonObject }
  >();
  const lines = [
    ...renderOuterRustDoc(doc.rustDoc, ""),
    `pub enum ${typeName} {`,
  ];
  for (const variant of union.variants) {
    lines.push(
      ...renderOuterRustDoc(
        typeVariantDoc(context, typeName, variant.value, doc),
        "    ",
      ),
    );
    const name = toRustVariantName(variant.value);
    const entries = Object.entries(variant.properties);
    if (entries.length === 0) {
      lines.push(`    ${name},`);
      continue;
    }
    lines.push(`    ${name} {`);
    for (const [wireName, schema] of entries) {
      if (!isJsonObject(schema) || !variant.required.includes(wireName)) {
        throw new Error(
          `${context.label}: sensitive variants require required object schemas`,
        );
      }
      const rustName = toRustFieldName(wireName);
      const existing = fields.get(wireName);
      if (existing && !isDeepStrictEqual(existing.schema, schema)) {
        throw new Error(
          `${context.label}: sensitive shared field ${wireName} has incompatible schemas`,
        );
      }
      const rustType =
        existing?.rustType ??
        context.fieldTypeOverrides[wireName] ??
        rustTypeForSchema(
          schema,
          nestedTypeNameForField(`${typeName}${name}`, wireName, schema),
          context,
        );
      fields.set(wireName, { rustName, rustType, schema });
      lines.push(
        ...renderOuterRustDoc(
          typeFieldDoc(context, typeName, wireName, doc),
          "        ",
        ),
      );
      lines.push(`        ${rustName}: ${rustType},`);
    }
    lines.push("    },");
  }
  lines.push(
    "}",
    "",
    `impl<'de> serde::Deserialize<'de> for ${typeName} {`,
    "    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
    "        // Decode fields directly: serde's internally tagged Content buffer would copy secrets.",
    "        #[derive(serde::Deserialize)]",
    "        enum Kind {",
  );
  for (const variant of union.variants) {
    lines.push(
      `            #[serde(rename = ${rustStringLiteral(variant.value)})]`,
      `            ${toRustVariantName(variant.value)},`,
    );
  }
  lines.push(
    "        }",
    "        #[derive(serde::Deserialize)]",
    "        #[serde(field_identifier)]",
    "        enum Field {",
    `            #[serde(rename = ${rustStringLiteral(union.tag)})]`,
    "            Outcome,",
  );
  for (const wireName of fields.keys()) {
    lines.push(
      `            #[serde(rename = ${rustStringLiteral(wireName)})]`,
      `            ${toPascalCase(wireName)},`,
    );
  }
  lines.push(
    "        }",
    "        struct Visitor;",
    "        impl<'de> serde::de::Visitor<'de> for Visitor {",
    `            type Value = ${typeName};`,
    "            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {",
    '                formatter.write_str("a private authority response object")',
    "            }",
    "            fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {",
    "                let mut outcome = None::<Kind>;",
  );
  for (const { rustName, rustType } of fields.values()) {
    lines.push(`                let mut ${rustName} = None::<${rustType}>;`);
  }
  lines.push(
    "                while let Some(field) = map.next_key::<Field>()? {",
    "                    match field {",
  );
  for (const [name, rustName] of [
    ["Outcome", "outcome"],
    ...Array.from(fields, ([wireName, field]) => {
      return [toPascalCase(wireName), field.rustName];
    }),
  ]) {
    lines.push(
      `                        Field::${name} => {`,
      `                            if ${rustName}.is_some() {`,
      '                                return Err(serde::de::Error::custom("duplicate authority field"));',
      "                            }",
      `                            ${rustName} = Some(map.next_value()?);`,
      "                        }",
    );
  }
  lines.push("                    }", "                }");
  const fieldList = [...fields.values()]
    .map((field) => {
      return field.rustName;
    })
    .join(", ");
  lines.push(`                match (outcome, ${fieldList}) {`);
  for (const variant of union.variants) {
    const name = toRustVariantName(variant.value);
    const values = [...fields].map(([wireName, field]) => {
      return wireName in variant.properties
        ? `Some(${field.rustName})`
        : "None";
    });
    const members = Object.keys(variant.properties).map(toRustFieldName);
    lines.push(
      `                    (Some(Kind::${name}), ${values.join(", ")}) => Ok(${typeName}::${name}${members.length > 0 ? ` { ${members.join(", ")} }` : ""}),`,
    );
  }
  lines.push(
    '                    _ => Err(serde::de::Error::custom("invalid authority outcome fields")),',
    "                }",
    "            }",
    "        }",
    "        deserializer.deserialize_map(Visitor)",
    "    }",
    "}",
  );
  context.declarations.push({ name: typeName, lines });
  return typeName;
}

function renderTaggedEnum(
  union: TaggedUnion,
  typeName: string,
  context: RenderTypeContext,
): string {
  if (context.sensitive) {
    return renderSensitiveTaggedEnum(union, typeName, context);
  }
  if (context.declarationNames.has(typeName)) {
    throw new Error(
      `${context.label} has duplicate Rust type name: ${typeName}`,
    );
  }
  context.declarationNames.add(typeName);
  const declarationDoc = typeDeclarationDoc(context, typeName);
  const hasFields = union.variants.some((variant) => {
    return Object.keys(variant.properties).length > 0;
  });

  const seenVariants = new Set<string>();
  const lines = [
    ...renderOuterRustDoc(declarationDoc.rustDoc, ""),
    hasFields
      ? "#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]"
      : "#[derive(",
    ...(hasFields
      ? []
      : [
          "    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize,",
          ")]",
        ]),
    hasFields
      ? `#[serde(tag = ${rustStringLiteral(union.tag)}, rename_all_fields = "camelCase")]`
      : `#[serde(tag = ${rustStringLiteral(union.tag)})]`,
    `pub enum ${typeName} {`,
  ];

  for (const taggedVariant of union.variants) {
    const variant = toRustVariantName(taggedVariant.value);
    if (seenVariants.has(variant)) {
      throw new Error(
        `${context.label}.${typeName} has duplicate Rust enum variant: ${variant}`,
      );
    }
    seenVariants.add(variant);
    lines.push(
      ...renderOuterRustDoc(
        typeVariantDoc(context, typeName, taggedVariant.value, declarationDoc),
        "    ",
      ),
    );
    lines.push(
      `    #[serde(rename = ${rustStringLiteral(taggedVariant.value)})]`,
    );
    if (Object.keys(taggedVariant.properties).length === 0) {
      lines.push(`    ${variant},`);
      continue;
    }

    lines.push(`    ${variant} {`);
    const required = new Set(taggedVariant.required);
    const seenRustFields = new Map<string, string>();
    for (const [wireName, rawPropertySchema] of Object.entries(
      taggedVariant.properties,
    )) {
      if (!isJsonObject(rawPropertySchema)) {
        throw new Error(
          `${context.label}.${typeName}.${variant}.${wireName} is not an object schema`,
        );
      }
      const rustName = toRustFieldName(wireName);
      const previousWireName = seenRustFields.get(rustName);
      if (previousWireName !== undefined) {
        throw new Error(
          `${context.label}.${typeName}.${variant} maps both ${previousWireName} and ${wireName} to Rust field ${rustName}`,
        );
      }
      seenRustFields.set(rustName, wireName);

      const optional = !required.has(wireName);
      const override = context.fieldTypeOverrides[wireName];
      const rawType =
        override ??
        rustTypeForSchema(
          rawPropertySchema,
          nestedTypeNameForField(
            `${typeName}${variant}`,
            wireName,
            rawPropertySchema,
          ),
          context,
        );
      const rustType =
        optional && !isOptionType(rawType) ? `Option<${rawType}>` : rawType;
      lines.push(
        ...renderOuterRustDoc(
          typeFieldDoc(context, typeName, wireName, declarationDoc),
          "        ",
        ),
      );
      for (const attribute of serdeFieldAttributes({
        wireName,
        rustName,
        optional,
      })) {
        lines.push(`        ${attribute}`);
      }
      const fieldLines = renderStructField(
        rustName,
        rustType,
        {
          ...context,
          moduleIndentWidth: context.moduleIndentWidth + 4,
        },
        false,
      );
      lines.push(
        ...fieldLines.map((line) => {
          return `    ${line}`;
        }),
      );
    }
    lines.push("    },");
  }

  lines.push("}");
  context.declarations.push({
    name: typeName,
    lines,
  });

  return typeName;
}

function renderModuleNode(
  node: ModuleNode,
  indent: string,
  modulePath: readonly string[],
): string[] {
  const lines: string[] = [];
  const routes = [...node.routes].sort(compareRouteBindings);
  const children = [...node.children.entries()].sort(
    ([leftName], [rightName]) => {
      return compareAscii(leftName, rightName);
    },
  );

  for (const route of routes) {
    const routeType = route.pathParams.length > 0 ? "RouteTemplate" : "Route";
    appendBlankLineIfNeeded(lines);
    lines.push(...renderRouteConstDoc(route, indent));
    lines.push(
      `${indent}pub const ${route.rustConstName}: crate::${routeType} = crate::${routeType} {`,
    );
    lines.push(
      `${indent}    method: crate::Method::${route.rustMethodVariant},`,
    );
    lines.push(`${indent}    path: ${rustStringLiteral(route.path)},`);
    lines.push(`${indent}};`);

    if (route.pathParams.length > 0) {
      lines.push("");
      lines.push(...renderParamsDoc(route, indent));
      lines.push(`${indent}#[derive(Debug, Clone, Copy)]`);
      lines.push(`${indent}pub struct Params<'a> {`);
      for (const param of route.pathParams) {
        lines.push(...renderPathParamDoc(param, `${indent}    `));
        lines.push(`${indent}    pub ${param.rustName}: &'a str,`);
      }
      lines.push(`${indent}}`);
      lines.push("");
      lines.push(...renderPathHelperDoc(route, indent));
      lines.push(`${indent}#[must_use]`);
      lines.push(`${indent}pub fn path(params: Params<'_>) -> String {`);
      lines.push(...renderParameterizedPath(route, `${indent}    `));
      lines.push(`${indent}}`);
      lines.push("");
      lines.push(...renderRouteHelperDoc(route, indent));
      lines.push(`${indent}#[must_use]`);
      lines.push(
        `${indent}pub fn route(params: Params<'_>) -> crate::ResolvedRoute {`,
      );
      lines.push(
        `${indent}    crate::ResolvedRoute::new(${route.rustConstName}.method, path(params))`,
      );
      lines.push(`${indent}}`);
    }
  }

  for (const [moduleName, child] of children) {
    appendBlankLineIfNeeded(lines);
    const childPath = [...modulePath, moduleName];
    lines.push(...renderRouteModuleDoc(childPath, indent));
    lines.push(`${indent}pub mod ${moduleName} {`);
    lines.push(...renderModuleNode(child, `${indent}    `, childPath));
    lines.push(`${indent}}`);
  }

  return lines;
}

function renderRouteModuleDoc(
  modulePath: readonly string[],
  indent: string,
): string[] {
  return renderOuterRustDoc(
    [`Generated route bindings under \`${modulePath.join("::")}\`.`],
    indent,
  );
}

function renderRouteConstDoc(
  route: NormalizedRouteBinding,
  indent: string,
): string[] {
  return renderOuterRustDoc(
    [
      rustDocSentence(route.summary),
      `Route contract: \`${routeContract(route)}\`.`,
    ],
    indent,
  );
}

function renderParamsDoc(
  route: NormalizedRouteBinding,
  indent: string,
): string[] {
  return renderOuterRustDoc(
    [`Path parameters for \`${routeContract(route)}\`.`],
    indent,
  );
}

function renderPathParamDoc(param: PathParamBinding, indent: string): string[] {
  return renderOuterRustDoc(
    [`Value for the \`:${param.routeName}\` path parameter.`],
    indent,
  );
}

function renderPathHelperDoc(
  route: NormalizedRouteBinding,
  indent: string,
): string[] {
  return renderOuterRustDoc(
    [
      `Build the concrete path for \`${routeContract(route)}\`.`,
      "Percent-encodes each path parameter as a URL path segment.",
    ],
    indent,
  );
}

function renderRouteHelperDoc(
  route: NormalizedRouteBinding,
  indent: string,
): string[] {
  return renderOuterRustDoc(
    [`Build a resolved route for \`${routeContract(route)}\`.`],
    indent,
  );
}

function routeContract(route: NormalizedRouteBinding): string {
  return `${route.method} ${route.path}`;
}

function rustDocSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function renderParameterizedPath(
  route: NormalizedRouteBinding,
  indent: string,
): string[] {
  const formatPath = route.path
    .split("/")
    .map((segment) => {
      return segment.startsWith(":") ? "{}" : escapeRustFormatString(segment);
    })
    .join("/");
  const args = route.pathParams.map((param) => {
    return `crate::route::encode_path_segment(params.${param.rustName})`;
  });

  const lines = [
    `${indent}format!(`,
    `${indent}    ${rustStringLiteral(formatPath)},`,
  ];
  for (const arg of args) {
    lines.push(`${indent}    ${arg},`);
  }
  lines.push(`${indent})`);
  return lines;
}

function escapeRustFormatString(value: string): string {
  return value.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

function decodePathNodeForSchema(
  schema: JsonObject,
  label: string,
): DecodePathNode {
  if ("$ref" in schema || "allOf" in schema) {
    throw new Error(`${label} uses unsupported referenced decode-path schema`);
  }

  const alternatives = decodePathAlternatives(schema, label);
  if (alternatives !== null) {
    return mergeDecodePathNodes(
      alternatives.map((alternative, index) => {
        return decodePathNodeForSchema(
          alternative,
          `${label} alternative ${index + 1}`,
        );
      }),
      label,
    );
  }

  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((type) => {
      return type !== "null";
    });
    if (nonNullTypes.length === 1 && schema.type.includes("null")) {
      const [nonNullType] = nonNullTypes;
      if (typeof nonNullType === "string") {
        return decodePathNodeForSchema({ ...schema, type: nonNullType }, label);
      }
    }
    throw new Error(`${label} uses unsupported decode-path type array`);
  }

  if (schema.type === "array") {
    if (!isJsonObject(schema.items)) {
      throw new Error(`${label} array is missing decode-path items`);
    }
    return {
      kind: "sequence",
      item: decodePathNodeForSchema(schema.items, `${label} item`),
    };
  }

  if (schema.type === "object") {
    return decodePathNodeForObject(schema, label);
  }

  if (
    schema.type === "string" ||
    schema.type === "number" ||
    schema.type === "integer" ||
    schema.type === "boolean" ||
    schema.type === "null" ||
    Object.keys(schema).length === 0
  ) {
    return { kind: "leaf" };
  }

  throw new Error(`${label} is missing a supported decode-path schema type`);
}

function decodePathAlternatives(
  schema: JsonObject,
  label: string,
): readonly JsonObject[] | null {
  const oneOf = schema.oneOf;
  const anyOf = schema.anyOf;
  if (oneOf !== undefined && anyOf !== undefined) {
    throw new Error(`${label} mixes oneOf and anyOf decode-path schemas`);
  }
  const alternatives = oneOf ?? anyOf;
  if (alternatives === undefined) {
    return null;
  }
  if (!Array.isArray(alternatives) || alternatives.length === 0) {
    throw new Error(`${label} uses malformed decode-path alternatives`);
  }
  if (
    !alternatives.every((alternative) => {
      return isJsonObject(alternative);
    })
  ) {
    throw new Error(`${label} uses non-object decode-path alternative`);
  }
  return alternatives;
}

function decodePathNodeForObject(
  schema: JsonObject,
  label: string,
): DecodePathNode {
  const properties = getOptionalObject(schema.properties);
  const propertyEntries = properties === null ? [] : Object.entries(properties);
  const additionalProperties = schema.additionalProperties;

  if (propertyEntries.length > 0) {
    if (additionalProperties !== false && additionalProperties !== undefined) {
      throw new Error(
        `${label} mixes fixed fields with dynamic decode-path fields`,
      );
    }
    return {
      kind: "object",
      fields: propertyEntries
        .map(([name, fieldSchema]) => {
          if (!isJsonObject(fieldSchema)) {
            throw new Error(`${label}.${name} has malformed field schema`);
          }
          return {
            name,
            node: decodePathNodeForSchema(fieldSchema, `${label}.${name}`),
          };
        })
        .sort((left, right) => {
          return compareAscii(left.name, right.name);
        }),
    };
  }

  if (isJsonObject(additionalProperties)) {
    return {
      kind: "dynamic-map",
      value: decodePathNodeForSchema(
        additionalProperties,
        `${label} map value`,
      ),
    };
  }

  if (additionalProperties === true) {
    throw new Error(
      `${label} uses unsupported untyped dynamic decode-path map`,
    );
  }

  if (properties !== null || additionalProperties === false) {
    return { kind: "object", fields: [] };
  }

  throw new Error(`${label} uses unsupported object decode-path schema`);
}

function mergeDecodePathNodes(
  nodes: readonly DecodePathNode[],
  label: string,
): DecodePathNode {
  const traversable = nodes.filter((node) => {
    return node.kind !== "leaf";
  });
  if (traversable.length === 0) {
    return { kind: "leaf" };
  }

  const [first] = traversable;
  if (first === undefined) {
    return { kind: "leaf" };
  }
  if (
    traversable.some((node) => {
      return node.kind !== first.kind;
    })
  ) {
    throw new Error(`${label} mixes incompatible decode-path shapes`);
  }

  switch (first.kind) {
    case "sequence":
      return {
        kind: "sequence",
        item: mergeDecodePathNodes(
          traversable.map((node) => {
            if (node.kind !== "sequence") {
              throw new Error(`${label} mixes incompatible sequence shapes`);
            }
            return node.item;
          }),
          `${label} sequence item`,
        ),
      };
    case "dynamic-map":
      return {
        kind: "dynamic-map",
        value: mergeDecodePathNodes(
          traversable.map((node) => {
            if (node.kind !== "dynamic-map") {
              throw new Error(`${label} mixes incompatible map shapes`);
            }
            return node.value;
          }),
          `${label} map value`,
        ),
      };
    case "object":
      return mergeDecodePathObjects(traversable, label);
  }
}

function mergeDecodePathObjects(
  nodes: readonly DecodePathNode[],
  label: string,
): DecodePathNode {
  const fields = new Map<string, DecodePathNode[]>();
  for (const node of nodes) {
    if (node.kind !== "object") {
      throw new Error(`${label} mixes incompatible object shapes`);
    }
    for (const field of node.fields) {
      const existing = fields.get(field.name);
      if (existing === undefined) {
        fields.set(field.name, [field.node]);
      } else {
        existing.push(field.node);
      }
    }
  }

  return {
    kind: "object",
    fields: [...fields.entries()]
      .sort(([leftName], [rightName]) => {
        return compareAscii(leftName, rightName);
      })
      .map(([name, fieldNodes]) => {
        return {
          name,
          node: mergeDecodePathNodes(fieldNodes, `${label}.${name}`),
        };
      }),
  };
}

function validateJsonSchema(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} did not produce a JSON schema object`);
  }

  return value;
}

function unwrapNullable(schema: JsonObject, label: string): JsonObject | null {
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((type) => {
      return type !== "null";
    });
    if (nonNullTypes.length === 1 && schema.type.includes("null")) {
      const [nonNullType] = nonNullTypes;
      if (typeof nonNullType === "string") {
        return {
          ...schema,
          type: nonNullType,
        };
      }
    }
    throw new Error(`${label} uses unsupported nullable type array`);
  }

  const anyOf = schema.anyOf;
  if (anyOf === undefined) {
    return null;
  }
  if (!Array.isArray(anyOf)) {
    throw new Error(`${label} uses malformed anyOf`);
  }

  const nonNullSchemas = anyOf.filter((entry): entry is JsonObject => {
    return isJsonObject(entry) && entry.type !== "null";
  });
  const nullSchemas = anyOf.filter((entry) => {
    return isJsonObject(entry) && entry.type === "null";
  });

  if (nonNullSchemas.length === 1 && nullSchemas.length === 1) {
    const nonNullSchema = nonNullSchemas[0];
    if (nonNullSchema !== undefined) {
      return nonNullSchema;
    }
  }

  throw new Error(`${label} uses unsupported anyOf schema`);
}

function getJsonSchemaType(schema: JsonObject, label: string): string {
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((type) => {
      return type !== "null";
    });
    if (nonNullTypes.length === 1 && schema.type.includes("null")) {
      return String(nonNullTypes[0]);
    }
    throw new Error(`${label} uses unsupported type array`);
  }

  if (typeof schema.type !== "string") {
    throw new Error(`${label} is missing a supported JSON schema type`);
  }

  return schema.type;
}

function getTaggedUnion(schema: JsonObject, label: string): TaggedUnion | null {
  const oneOf = schema.oneOf;
  if (oneOf === undefined) {
    return null;
  }
  if (!Array.isArray(oneOf) || oneOf.length === 0) {
    throw new Error(`${label} uses malformed oneOf`);
  }

  const variants = oneOf.map((entry) => {
    return getTaggedVariant(entry, label);
  });
  const first = variants[0];
  if (first === undefined) {
    throw new Error(`${label} uses unsupported oneOf schema`);
  }
  if (
    variants.some((variant) => {
      return variant.tag !== first.tag;
    })
  ) {
    throw new Error(`${label} uses inconsistent oneOf discriminator fields`);
  }
  return {
    tag: first.tag,
    variants: variants.map(({ value, properties, required }) => {
      return {
        value,
        properties,
        required,
      };
    }),
  };
}

function getTaggedVariant(
  entry: unknown,
  label: string,
): TaggedUnionVariant & { readonly tag: string } {
  if (!isJsonObject(entry) || entry.type !== "object") {
    throw new Error(`${label} uses unsupported oneOf schema`);
  }
  const properties = getOptionalObject(entry.properties);
  const propertyEntries = properties && Object.entries(properties);
  const required = getStringArray(entry.required);
  if (
    propertyEntries === null ||
    propertyEntries.length === 0 ||
    required === null ||
    entry.additionalProperties !== false
  ) {
    throw new Error(`${label} uses unsupported oneOf schema`);
  }
  const tagEntries = propertyEntries.filter(([, rawSchema]) => {
    return isJsonObject(rawSchema) && typeof rawSchema.const === "string";
  });
  if (tagEntries.length !== 1) {
    throw new Error(`${label} uses unsupported oneOf schema`);
  }
  const tagEntry = tagEntries[0];
  if (tagEntry === undefined) {
    throw new Error(`${label} uses unsupported oneOf schema`);
  }
  const [tag, rawTagSchema] = tagEntry;
  if (
    !required.includes(tag) ||
    !isJsonObject(rawTagSchema) ||
    rawTagSchema.type !== "string" ||
    typeof rawTagSchema.const !== "string"
  ) {
    throw new Error(`${label} uses unsupported oneOf schema`);
  }
  const variantProperties = Object.fromEntries(
    propertyEntries.filter(([wireName]) => {
      return wireName !== tag;
    }),
  );
  return {
    tag,
    value: rawTagSchema.const,
    properties: variantProperties,
    required: required.filter((wireName) => {
      return wireName !== tag;
    }),
  };
}

function getOptionalObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function getStringArray(value: unknown): readonly string[] | null {
  if (
    Array.isArray(value) &&
    value.every((entry) => {
      return typeof entry === "string";
    })
  ) {
    return value;
  }

  return null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionType(value: string): boolean {
  return value.startsWith("Option<");
}

function serdeFieldAttributes({
  wireName,
  rustName,
  optional,
}: {
  readonly wireName: string;
  readonly rustName: string;
  readonly optional: boolean;
}): string[] {
  const entries: string[] = [];
  if (toCamelCase(rustName) !== wireName) {
    entries.push(`rename = ${rustStringLiteral(wireName)}`);
  }
  if (optional) {
    entries.push("default");
    entries.push('skip_serializing_if = "Option::is_none"');
  }

  return entries.length > 0 ? [`#[serde(${entries.join(", ")})]`] : [];
}

function toRustFieldName(wireName: string): string {
  const snake = toSnakeCase(wireName);
  return rustKeywords.has(snake) ? `${snake}_` : snake;
}

function nestedTypeNameForField(
  parentTypeName: string,
  wireName: string,
  schema: JsonObject,
): string {
  let fieldName = toPascalCase(wireName);
  if (
    schema.type === "array" &&
    fieldName.endsWith("s") &&
    fieldName.length > 1
  ) {
    fieldName = fieldName.slice(0, -1);
  }

  return `${parentTypeName}${fieldName}`;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, char: string) => {
    return char.toUpperCase();
  });
}

function toPascalCase(value: string): string {
  const words = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+|_/)
    .filter((word) => {
      return word.length > 0;
    });
  const pascal = words
    .map((word) => {
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join("");

  return pascal.length > 0 ? pascal : "Value";
}

function toRustVariantName(value: string): string {
  const variant = toPascalCase(value);
  const name = /^[0-9]/.test(variant) ? `V${variant}` : variant;
  return rustKeywords.has(name) ? `${name}_` : name;
}

function compareAscii(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function appendBlankLineIfNeeded(lines: string[]): void {
  if (lines.length > 0) {
    lines.push("");
  }
}

function rustStringLiteral(value: string): string {
  let literal = '"';

  for (const char of value) {
    if (char === "\\") {
      literal += "\\\\";
    } else if (char === '"') {
      literal += '\\"';
    } else if (char === "\n") {
      literal += "\\n";
    } else if (char === "\r") {
      literal += "\\r";
    } else if (char === "\t") {
      literal += "\\t";
    } else {
      const codePoint = char.codePointAt(0);
      if (codePoint !== undefined && codePoint < 0x20) {
        literal += `\\u{${codePoint.toString(16)}}`;
      } else {
        literal += char;
      }
    }
  }

  return `${literal}"`;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  void generateRustBindings().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
