import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import process from "node:process";

import tseslint from "typescript-eslint";

const CHECKER = "turbo/scripts/check-storage-dependencies.mjs";
const BASELINE = "turbo/storage-dependency-baseline.json";
const TABLES = new Set([
  "storages",
  "storage_versions",
  "storage_version_lineage",
  "storage_publication_generations",
  "storage_publication_tokens",
]);
const MEMBERS = new Set([
  "storages",
  "storageVersions",
  "storageVersionLineage",
  "storagePublicationGenerations",
  "storagePublicationTokens",
]);
const MODULES = new Set(
  [
    "schema/storage",
    "schema/storage-version-lineage",
    "schema/storage-publication-fence",
  ].map((name) => {
    return "turbo/packages/db/src/" + name;
  }),
);
// #46270 explicitly permits exact-version Storage reconstruction in Claim.
// Acknowledgment in the base inventory consumes this amendment permanently.
const APPROVED_AMENDMENTS = new Map([
  // #46806 moves the existing preparation owners without adding Storage uses.
  [
    "direct-execution-source-owner-rename",
    [
      {
        file: "turbo/apps/api/src/signals/services/execution-context.ts",
        dependency:
          "module:turbo/apps/api/src/signals/services/execution-storage.service",
        uses: 2,
      },
      {
        file: "turbo/apps/api/src/signals/services/execution-runtime-context.ts",
        dependency:
          "module:turbo/apps/api/src/signals/services/execution-storage.service",
        uses: 2,
      },
    ],
  ],
  [
    "claim-source-reconstruction",
    [
      {
        file: "turbo/apps/api/src/signals/services/claim-execution-context.ts",
        dependency:
          "module:turbo/apps/api/src/signals/services/execution-storage.service",
        uses: 2,
      },
      {
        file: "turbo/apps/api/src/signals/services/claim-runtime-context.ts",
        dependency:
          "module:turbo/apps/api/src/signals/services/execution-storage.service",
        uses: 2,
      },
      {
        file: "turbo/apps/api/src/signals/services/execution-storage.service.ts",
        dependency: "module:turbo/packages/db/src/schema/storage",
        uses: 26,
      },
    ],
  ],
]);
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

function git(args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function isSource(file) {
  return (
    /\.(?:[cm]?[jt]sx?)$/u.test(file) &&
    !/\.d\.[cm]?ts$/u.test(file) &&
    !/(^|\/)(?:node_modules|dist|coverage|__tests__|tests?|fixtures|test-fixtures|mocks)(\/|$)/u.test(
      file,
    ) &&
    !/(?:^|\/)test-[^/]+$|[.-](?:test|spec|suite)\.[cm]?[jt]sx?$/u.test(file) &&
    file !== CHECKER
  );
}

function sourceFiles(list) {
  return [...new Set(list.split("\0").filter(isSource))].sort();
}

function moduleName(file) {
  return file.replace(/\.[cm]?[jt]sx?$/u, "");
}

function moduleTarget(file, specifier, available) {
  let target;
  if (specifier.startsWith(".")) {
    target = posix.normalize(posix.join(posix.dirname(file), specifier));
  } else if (specifier === "@okouai/db") {
    target = "turbo/packages/db/src/index";
  } else if (specifier.startsWith("@okouai/db/")) {
    target = "turbo/packages/db/src/" + specifier.slice("@okouai/db/".length);
  } else {
    return undefined;
  }
  target = moduleName(target);
  return available.has(target + "/index") ? target + "/index" : target;
}

function tableReferences(text, tableDeclaration = false) {
  if (TABLES.has(text)) return tableDeclaration ? [text] : [];
  // Keep SQL identifiers, but not comments or single-quoted data. This is a
  // lexical guard for literal SQL, not execution or arbitrary SQL data flow.
  const tokens = [
    ...text.matchAll(
      /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9]*|[.]/gu,
    ),
  ]
    .map(([token]) => {
      if (/^(?:--|\/\*|')/u.test(token)) return undefined;
      return token.startsWith('"')
        ? token.slice(1, -1).replaceAll('""', '"')
        : token.toLowerCase();
    })
    .filter((token) => {
      return token !== undefined;
    });
  return tokens.filter((token, index) => {
    if (!TABLES.has(token)) return false;
    let previous = index - 1;
    while (tokens[previous] === ".") previous -= 2;
    if (tokens[previous] === "only") previous--;
    return [
      "from",
      "join",
      "into",
      "update",
      "table",
      "references",
      "truncate",
    ].includes(tokens[previous]);
  });
}

function staticText(node) {
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  return undefined;
}

function importedModule(node) {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
    case "ImportExpression":
      return staticText(node.source);
    case "CallExpression":
      return node.callee.type === "Identifier" && node.callee.name === "require"
        ? staticText(node.arguments[0])
        : undefined;
    case "TSImportEqualsDeclaration":
      return staticText(node.moduleReference.expression);
    case "TSImportType":
      return staticText(node.argument.literal);
    default:
      return undefined;
  }
}

function scanSource(file, code, available) {
  const parsed = tseslint.parser.parseForESLint(code, {
    filePath: file,
    loc: true,
    range: true,
    jsx: true,
    sourceType: "module",
  });
  const imports = new Map();
  const records = [];
  const parents = new WeakMap();
  const tableFactories = new Set();
  const schemaReferences = new Set();
  for (const scope of parsed.scopeManager.scopes) {
    for (const variable of scope.variables) {
      for (const definition of variable.defs) {
        if (definition.type !== "ImportBinding") continue;
        if (definition.parent.type !== "ImportDeclaration") continue;
        const name =
          definition.node.imported?.name ?? definition.node.imported?.value;
        const source = definition.parent.source.value;
        const factory = name === "pgTable" && source === "drizzle-orm/pg-core";
        const schema =
          name === "schema" &&
          moduleTarget(file, source, available) ===
            "turbo/packages/db/src/index";
        for (const reference of variable.references) {
          if (factory) tableFactories.add(reference.identifier);
          if (schema) schemaReferences.add(reference.identifier);
        }
      }
    }
  }

  function isSchemaObject(node) {
    if (!node) return false;
    if (schemaReferences.has(node)) return true;
    return (
      node.type === "MemberExpression" &&
      ["query", "schema"].includes(
        node.computed ? node.property.value : node.property.name,
      )
    );
  }

  function addImport(node, value) {
    if (typeof value !== "string") return;
    const target = moduleTarget(file, value, available);
    if (target)
      imports.set(node, { target, uses: 1, line: node.loc.start.line });
  }

  function collectTables(node, parent) {
    if (node.type === "Literal" && typeof node.value === "string") {
      const tableDeclaration =
        parent?.type === "CallExpression" &&
        (parent.callee.name === "pgTable" ||
          parent.callee.property?.name === "pgTable" ||
          tableFactories.has(parent.callee));
      for (const table of tableReferences(node.value, tableDeclaration))
        records.push({ dependency: "sql:" + table, line: node.loc.start.line });
    } else if (node.type === "TemplateLiteral") {
      for (const table of tableReferences(
        node.quasis
          .map((part) => {
            return part.value.cooked ?? part.value.raw;
          })
          .join(" __expression__ "),
      ))
        records.push({ dependency: "sql:" + table, line: node.loc.start.line });
    }
  }

  function collectMembers(node, parent) {
    if (node.type === "MemberExpression") {
      const name = node.computed ? node.property.value : node.property.name;
      if (MEMBERS.has(name) && isSchemaObject(node.object))
        records.push({
          dependency: "member:" + name,
          line: node.loc.start.line,
        });
    } else if (node.type === "Property" && parent?.type === "ObjectPattern") {
      const declaration = parents.get(parent);
      const name = node.computed
        ? node.key.value
        : (node.key.name ?? node.key.value);
      if (
        MEMBERS.has(name) &&
        declaration?.type === "VariableDeclarator" &&
        isSchemaObject(declaration.init)
      )
        records.push({
          dependency: "member:" + name,
          line: node.loc.start.line,
        });
    }
  }

  function visit(node, parent) {
    if (parent) parents.set(node, parent);
    addImport(node, importedModule(node));
    collectTables(node, parent);
    collectMembers(node, parent);
    for (const key of parsed.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const entry of child) if (entry) visit(entry, node);
      } else if (child) {
        visit(child, node);
      }
    }
  }
  visit(parsed.ast);

  // The parser's lexical scopes distinguish renamed imports from shadowing.
  // Count references as well as import edges, so an existing import is not a
  // file-wide exemption for additional calls or type dependencies.
  for (const scope of parsed.scopeManager.scopes) {
    for (const variable of scope.variables) {
      for (const definition of variable.defs) {
        if (definition.type !== "ImportBinding") continue;
        const entry = imports.get(definition.parent);
        if (entry) entry.uses += variable.references.length;
      }
    }
  }
  return { file, imports: [...imports.values()], records };
}

function inventory(sources) {
  const available = new Set(
    sources.map(({ file }) => {
      return moduleName(file);
    }),
  );
  const scanned = sources.map(({ file, code }) => {
    try {
      return scanSource(file, code, available);
    } catch (error) {
      throw new Error(file + ": " + error.message, { cause: error });
    }
  });
  const owners = new Set(MODULES);
  for (const source of scanned) {
    // DB initialization aggregates every schema; treating that aggregation as
    // a Storage API would incorrectly prohibit every new database consumer.
    if (moduleName(source.file) === "turbo/packages/db/src/index") continue;
    if (
      source.records.length ||
      source.imports.some(({ target }) => {
        return MODULES.has(target);
      })
    )
      owners.add(moduleName(source.file));
  }
  const sites = new Map();
  for (const source of scanned) {
    const records = [
      ...source.records.map((record) => {
        return { ...record, uses: 1 };
      }),
      ...source.imports
        .filter(({ target }) => {
          return owners.has(target);
        })
        .map(({ target, ...record }) => {
          return { ...record, dependency: "module:" + target };
        }),
    ];
    for (const record of records) {
      const key = JSON.stringify([source.file, record.dependency]);
      const existing = sites.get(key);
      if (existing) existing.uses += record.uses;
      else sites.set(key, { file: source.file, ...record });
    }
  }
  return [...sites.values()].sort((a, b) => {
    return (
      a.file.localeCompare(b.file) || a.dependency.localeCompare(b.dependency)
    );
  });
}

function parseAmendments(amendments = []) {
  if (
    !Array.isArray(amendments) ||
    new Set(amendments).size !== amendments.length ||
    amendments.some((id) => {
      return !APPROVED_AMENDMENTS.has(id);
    })
  )
    throw new Error("Invalid Storage policy amendment acknowledgment.");
  return amendments;
}

function parseBaseline(text) {
  const value = JSON.parse(text);
  if (value?.version !== 1 || !Array.isArray(value.sites))
    throw new Error("Invalid Storage dependency inventory.");
  const amendments = parseAmendments(value.amendments);
  const keys = new Set();
  for (const site of value.sites) {
    if (
      !site ||
      typeof site.file !== "string" ||
      !isSource(site.file) ||
      posix.normalize(site.file) !== site.file ||
      site.file.startsWith("../") ||
      posix.isAbsolute(site.file) ||
      typeof site.dependency !== "string" ||
      !/^(?:module|member|sql):.+$/u.test(site.dependency) ||
      !Number.isSafeInteger(site.uses) ||
      site.uses < 1 ||
      Object.keys(site).sort().join(",") !== "dependency,file,uses"
    )
      throw new Error("Invalid Storage dependency inventory entry.");
    const key = JSON.stringify([site.file, site.dependency]);
    if (keys.has(key)) throw new Error("Duplicate Storage dependency entry.");
    keys.add(key);
  }
  return { sites: value.sites, amendments };
}

function amendedCeilings(current, base) {
  if (
    base.amendments.some((id) => {
      return !current.amendments.includes(id);
    })
  )
    throw new Error(
      "Storage policy amendment acknowledgments cannot be removed.",
    );
  const ceilings = new Map(
    base.sites.map((site) => {
      return [JSON.stringify([site.file, site.dependency]), site];
    }),
  );
  for (const id of current.amendments) {
    if (base.amendments.includes(id)) continue;
    for (const site of APPROVED_AMENDMENTS.get(id)) {
      const key = JSON.stringify([site.file, site.dependency]);
      if (site.uses > (ceilings.get(key)?.uses ?? 0)) ceilings.set(key, site);
    }
  }
  return [...ceilings.values()];
}

function compare(actual, allowed, exact) {
  const remaining = new Map(
    allowed.map((site) => {
      return [JSON.stringify([site.file, site.dependency]), site];
    }),
  );
  const errors = [];
  for (const site of actual) {
    const key = JSON.stringify([site.file, site.dependency]);
    const expected = remaining.get(key);
    if (site.uses > (expected?.uses ?? 0))
      errors.push(
        site.file +
          ":" +
          (site.line ?? 1) +
          ": " +
          site.dependency +
          " grew from " +
          (expected?.uses ?? 0) +
          " to " +
          site.uses +
          ". New legacy Storage dependencies are prohibited.",
      );
    else if (exact && site.uses < expected.uses)
      errors.push(
        site.file + ": reduce the stale baseline for " + site.dependency,
      );
    remaining.delete(key);
  }
  if (exact) {
    for (const site of remaining.values())
      errors.push(
        site.file + ": remove the unused baseline for " + site.dependency,
      );
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

function currentSources() {
  return sourceFiles(
    git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  ).map((file) => {
    return { file, code: readFileSync(resolve(repo, file), "utf8") };
  });
}

function existsAt(revision, file) {
  return git(["ls-tree", "--name-only", revision, "--", file]).trim() === file;
}

const [base, ...extra] = process.argv.slice(2);
if (
  extra.length ||
  (base !== "--inventory" && !/^[a-f0-9]{40}$/u.test(base ?? ""))
)
  throw new Error(
    "Usage: node scripts/check-storage-dependencies.mjs <full-base-main-sha> | --inventory",
  );
if (base === "--inventory") {
  const amendments = existsSync(resolve(repo, BASELINE))
    ? parseBaseline(readFileSync(resolve(repo, BASELINE), "utf8")).amendments
    : [];
  console.log(
    JSON.stringify(
      {
        version: 1,
        ...(amendments.length ? { amendments } : {}),
        sites: inventory(currentSources()).map(({ line: _line, ...site }) => {
          return site;
        }),
      },
      null,
      2,
    ),
  );
} else {
  git(["cat-file", "-e", base + "^{commit}"]);
  const current = parseBaseline(readFileSync(resolve(repo, BASELINE), "utf8"));
  let allowed;
  if (existsAt(base, BASELINE)) {
    allowed = parseBaseline(git(["show", base + ":" + BASELINE]));
  } else {
    if (existsAt(base, CHECKER))
      throw new Error(
        "Base/main lost its enforced Storage inventory; bootstrap is closed.",
      );
    // Initial activation may register only dependencies actually in base/main,
    // never new references introduced alongside the candidate baseline.
    allowed = {
      amendments: [],
      sites: inventory(
        sourceFiles(git(["ls-tree", "-r", "--name-only", "-z", base])).map(
          (file) => {
            return { file, code: git(["show", base + ":" + file]) };
          },
        ),
      ),
    };
  }
  compare(current.sites, amendedCeilings(current, allowed), false);
  compare(inventory(currentSources()), current.sites, true);
  console.log(
    "Storage dependency policy passed: " +
      current.sites.length +
      " exact file/dependency entries; base " +
      base +
      ".",
  );
}
