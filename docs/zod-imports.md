# Zod imports

Import the Zod functions and types used by a module explicitly:

```typescript
import { object, string, type infer as Infer } from "zod";

const personSchema = object({ name: string() });
type Person = Infer<typeof personSchema>;
```

Do not import the aggregate `z`, a default export, or a module namespace:

```typescript
import { z } from "zod";
import { z as schema } from "zod";
import * as z from "zod";
import z from "zod";
```

The `zod/named-imports` ESLint rule enforces this convention in TypeScript
workspaces, including TSX and tests. The same rule applies to Zod subpaths such
as `zod/v4` and `zod/mini`, and to type-only imports. A locale leaf module's
default locale factory is not a schema aggregate and remains allowed.

## Why explicit imports

An ESM named import of the package's aggregate `z` and an ESM module namespace
import are different bindings. With the repository's pinned Zod and esbuild,
importing the re-exported aggregate `z` can retain substantially more runtime
code than importing individual members. This is a package export and bundler
interaction; these import forms are all ESM.

A native namespace import can produce the same optimized output as explicit
named imports for a small schema. We still require explicit names to make each
module's dependencies visible and keep one convention across the repository.
Do not recreate the aggregate through a local barrel or wrapper.

Bundle probes establish retained code for their exact entry point, dependency
versions, output format, target and conditions. They do not establish full-API
savings, Cloudflare initialization CPU, or behavior across all bundlers. When
comparing forms, preserve the same live schema and build options, inspect the
output bytes and contributing modules, and record the pinned versions with the
results in the owning PR.

## Types, nested members and aliases

Use explicit named type imports. Type-only imports are erased from JavaScript;
their import spelling is a consistency and type-dependency concern, not a
runtime startup cost.

```typescript
import type { infer as Infer, ZodType } from "zod";
import type { $ZodIssue } from "zod/v4/core";
```

A nested member should keep its owning export and semantics. For example,
`z.coerce.number()` becomes `coerce.number()` with `import { coerce } from
"zod"`; it must not become the non-coercing `number()`. For a nested core type,
import the type from `zod/v4/core` as shown above.

Alias keywords and names that collide with another declaration, including
names shadowed in a nested scope:

```typescript
import { enum as zEnum, object as zObject, string as zString } from "zod";

const object = zObject({ name: zString(), role: zEnum(["owner", "member"]) });
```

The rule reports aggregate imports without an automatic fix. Migrating their
uses requires resolving the imported binding, preserving type positions and
nested members, and choosing aliases that cannot capture local identifiers.
A text replacement of `z.` cannot establish those properties.

## Reproduce a bundle comparison

After installing the pinned workspace dependencies, run this from `turbo/apps/api`:

```sh
node --input-type=module <<'JS'
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build, version as esbuildVersion } from "esbuild";

const require = createRequire(`${process.cwd()}/package.json`);
const cases = {
  aggregate: 'import { z } from "zod"; export const schema = z.object({ name: z.string() });',
  namespace: 'import * as z from "zod"; export const schema = z.object({ name: z.string() });',
  named: 'import { object, string } from "zod"; export const schema = object({ name: string() });',
};
console.log({ zod: require("zod/package.json").version, esbuild: esbuildVersion });
for (const conditions of [[], ["workerd", "worker"], ["workerd", "worker", "module"]]) {
  for (const [name, contents] of Object.entries(cases)) {
    const result = await build({
      stdin: { contents, resolveDir: process.cwd(), sourcefile: "probe.ts", loader: "ts" },
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "node",
      target: "es2022",
      minify: true,
      keepNames: true,
      conditions,
    });
    const bytes = result.outputFiles[0].contents;
    const inputs = Object.values(result.metafile.outputs)[0].inputs;
    console.log({
      name,
      conditions,
      bytes: bytes.byteLength,
      positiveByteModules: Object.values(inputs).filter(input => input.bytesInOutput > 0).length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}
JS
```

The probe exports one live `object({ name: string() })` schema. Counts include
only input modules contributing positive output bytes. Identical hashes mean
identical emitted JavaScript for this probe; they do not prove identical
results for other schemas, bundler versions or application entry points.
