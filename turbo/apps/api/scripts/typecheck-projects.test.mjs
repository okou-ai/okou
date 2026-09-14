import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import process from "node:process";

import ts from "typescript";

import { prepareTestProjects } from "./prepare-typecheck-tests.mjs";

function write(root, file, content) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "api-typecheck-projects-"));
  t.after(() => {
    return rmSync(root, { recursive: true, force: true });
  });
  for (const name of [
    "tsconfig.json",
    "tsconfig.gateways.json",
    "tsconfig.core.json",
    "tsconfig.routes.json",
    "tsconfig.bootstrap.json",
    "tsconfig.tests.json",
    "tsconfig.bootstrap-wiring.json",
  ]) {
    copyFileSync(join(import.meta.dirname, "..", name), join(root, name));
  }
  mkdirSync(join(root, "scripts"));
  for (const name of [
    "prepare-typecheck-tests.mjs",
    "check-typecheck-boundaries.mjs",
  ]) {
    copyFileSync(join(import.meta.dirname, name), join(root, "scripts", name));
  }
  symlinkSync(
    resolve(import.meta.dirname, "../node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  for (const file of [
    ...JSON.parse(readFileSync(join(root, "tsconfig.gateways.json"))).include,
    "src/signals/routes/example.ts",
    "src/lib/example.ts",
    "src/__tests__/alpha.test.ts",
    "src/__tests__/beta.test.ts",
    "src/__tests__/gamma.test.ts",
    "src/lib/__benches__/sample.bench.ts",
    "src/test-fixtures/example.ts",
  ]) {
    write(root, file, "export {};\n");
  }
  for (const file of ["src/index.ts", "src/server.ts"]) {
    write(root, file, 'import "./production-bootstrap";\n');
  }
  write(root, "src/production-bootstrap.ts", 'import "./signals/route";\n');
  write(root, "src/signals/route.ts", "export {};\n");
  for (const file of ["route-registration", "vercel-crons"]) {
    write(
      root,
      `src/__tests__/${file}.test.ts`,
      'import "../signals/route";\n',
    );
  }
  write(root, "src/lib/db.ts", "export {};\n");
  write(
    root,
    "src/lib/db-types.ts",
    "type ApiDb = NodePgDatabase<Record<string, never>>;\n",
  );
  write(root, "src/lib/data.json", "{}\n");
  write(root, "src/signals/routes/data.json", "{}\n");
  write(root, "src/__tests__/data.json", "{}\n");
  return root;
}

function run(root, script) {
  return spawnSync(process.execPath, [join(root, "scripts", script)], {
    cwd: root,
    encoding: "utf8",
  });
}

function prepare(root) {
  prepareTestProjects(root);
}

function guard(root) {
  return run(root, "check-typecheck-boundaries.mjs");
}

function accepted(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /missing=0; extra=0; overlaps=0/);
}

function rejected(result, message) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
}

function config(root, name) {
  const path = join(root, name);
  const json = ts.readConfigFile(path, ts.sys.readFile);
  assert.equal(json.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    json.config,
    ts.sys,
    dirname(path),
    undefined,
    path,
  );
  assert.deepEqual(parsed.errors, []);
  return parsed;
}

function generatedNames() {
  return [0, 1].map((index) => {
    return `.typecheck/tsconfig.tests-${index}.json`;
  });
}

function changeConfig(root, name, mutate) {
  const value = JSON.parse(readFileSync(join(root, name), "utf8"));
  mutate(value);
  write(root, name, `${JSON.stringify(value, null, 2)}\n`);
}

test("generated programs retain compiler semantics, references and every canonical root", (t) => {
  const root = fixture(t);
  const result = run(root, "prepare-typecheck-tests.mjs");
  assert.equal(result.status, 0, result.stderr);
  accepted(guard(root));
  const canonical = config(root, "tsconfig.tests.json");
  const children = generatedNames().map((name) => {
    return config(root, name);
  });
  const files = children.flatMap((child) => {
    return child.fileNames;
  });
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(files.toSorted(), canonical.fileNames.toSorted());
  for (const child of children) {
    assert.equal(child.options.rootDir, root);
    assert.equal(child.options.strict, true);
    assert.equal(child.options.noUncheckedIndexedAccess, true);
    assert.equal(child.options.disableSourceOfProjectReferenceRedirect, true);
    assert.deepEqual(
      child.projectReferences.map((ref) => {
        return ref.path;
      }),
      canonical.projectReferences.map((ref) => {
        return ref.path;
      }),
    );
    assert.deepEqual(child.raw.include, []);
  }
  assert.notEqual(
    children[0].options.tsBuildInfoFile,
    children[1].options.tsBuildInfoFile,
  );
  const mtimes = generatedNames().map((name) => {
    return statSync(join(root, name), { bigint: true }).mtimeNs;
  });
  const contents = generatedNames().map((name) => {
    return readFileSync(join(root, name), "utf8");
  });
  prepare(root);
  assert.deepEqual(
    generatedNames().map((name) => {
      return statSync(join(root, name), { bigint: true }).mtimeNs;
    }),
    mtimes,
  );
  assert.deepEqual(
    generatedNames().map((name) => {
      return readFileSync(join(root, name), "utf8");
    }),
    contents,
  );
});

test("membership follows additions, deletions and renames and rejects stale output", (t) => {
  const root = fixture(t);
  prepare(root);
  const owners = () => {
    return new Map(
      generatedNames().flatMap((name) => {
        return config(root, name).fileNames.map((file) => {
          return [file, name];
        });
      }),
    );
  };
  const original = owners();
  const added = "src/__tests__/added.test.ts";
  write(root, added, "export {};\n");
  rejected(guard(root), /Stale or modified test project/);
  prepare(root);
  accepted(guard(root));
  assert.ok(owners().has(join(root, added)));
  for (const [file, owner] of original) assert.equal(owners().get(file), owner);
  const renamed = "src/__tests__/renamed.test.ts";
  renameSync(join(root, added), join(root, renamed));
  rejected(guard(root), /Stale or modified test project/);
  prepare(root);
  assert.ok(!owners().has(join(root, added)));
  assert.ok(owners().has(join(root, renamed)));
  rmSync(join(root, renamed));
  rejected(guard(root), /Stale or modified test project/);
  prepare(root);
  accepted(guard(root));
  assert.deepEqual(owners(), original);
});

test("missing, extra, duplicated and malformed generated roots cannot pass the guard", (t) => {
  const root = fixture(t);
  prepare(root);
  const name = generatedNames()[0];
  for (const mutate of [
    (value) => {
      return value.files.pop();
    },
    (value) => {
      return value.files.push("../src/lib/example.ts");
    },
    (value) => {
      return value.files.push(value.files[0]);
    },
    (value) => {
      return value.references.pop();
    },
    (value) => {
      value.compilerOptions.strict = false;
    },
  ]) {
    changeConfig(root, name, mutate);
    rejected(guard(root), /Stale or modified test project/);
    prepare(root);
  }
  write(root, name, "{broken");
  rejected(guard(root), /Stale or modified test project/);
  prepare(root);
  rmSync(join(root, name));
  rejected(guard(root), /ENOENT/);
  prepare(root);
  accepted(guard(root));
});

test("canonical parse errors and missing or duplicate explicit roots fail preparation", (t) => {
  const root = fixture(t);
  prepare(root);
  const name = "tsconfig.tests.json";
  const original = readFileSync(join(root, name), "utf8");
  for (const mutate of [
    (value) => {
      value.compilerOptions.strict = "yes";
    },
    (value) => {
      value.files = ["src/__tests__/absent.test.ts"];
    },
    (value) => {
      value.files = [
        "src/__tests__/alpha.test.ts",
        "src/__tests__/alpha.test.ts",
      ];
    },
    (value) => {
      delete value.references;
    },
    (value) => {
      delete value.compilerOptions.rootDir;
    },
  ]) {
    changeConfig(root, name, mutate);
    rejected(
      run(root, "prepare-typecheck-tests.mjs"),
      /strict|ENOENT|Duplicate|rootDir|references/,
    );
    rejected(guard(root), /strict|ENOENT|Duplicate|rootDir|references/);
    write(root, name, original);
  }
  write(root, name, "{broken");
  rejected(run(root, "prepare-typecheck-tests.mjs"), /expected/);
});

test("production ownership includes JSON and rejects uncovered or overlapping inputs", (t) => {
  const root = fixture(t);
  prepare(root);
  accepted(guard(root));
  write(root, "src/unowned/new.ts", "export {};\n");
  rejected(guard(root), /missing baseline roots/);
  rmSync(join(root, "src/unowned"), { recursive: true });
  for (const name of ["tsconfig.core.json", "tsconfig.routes.json"]) {
    const original = readFileSync(join(root, name), "utf8");
    changeConfig(root, name, (value) => {
      value.include = value.include.filter((pattern) => {
        return !pattern.endsWith(".json");
      });
    });
    rejected(guard(root), /JSON.*missing/);
    write(root, name, original);
  }
  changeConfig(root, "tsconfig.core.json", (value) => {
    value.include.push(
      "src/signals/routes/**/*",
      "src/signals/routes/**/*.json",
    );
    value.exclude = value.exclude.filter((pattern) => {
      return pattern !== "src/signals/routes/**/*";
    });
  });
  rejected(guard(root), /exactly one Program|JSON.*overlap/);
});
