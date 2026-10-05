import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

import {
  prepareTestProjects,
  validateTestProjects,
} from "./prepare-typecheck-tests.mjs";

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
    "tsconfig.foundation.json",
    "tsconfig.admission.json",
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
    ...JSON.parse(readFileSync(join(root, "tsconfig.foundation.json"))).include,
    ...JSON.parse(readFileSync(join(root, "tsconfig.admission.json"))).include,
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
  return [0, 1, 2].map((index) => {
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
  assert.equal(
    new Set(
      children.map((child) => {
        return child.options.tsBuildInfoFile;
      }),
    ).size,
    children.length,
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

test("foundation roots are unique, declaration-isolated and cannot import downstream sources", (t) => {
  const root = fixture(t);
  prepare(root);
  accepted(guard(root));
  const foundation = config(root, "tsconfig.foundation.json");
  const core = config(root, "tsconfig.core.json");
  assert.equal(foundation.options.composite, true);
  assert.equal(foundation.options.emitDeclarationOnly, true);
  assert.equal(
    foundation.options.disableSourceOfProjectReferenceRedirect,
    true,
  );
  assert.equal(foundation.options.strict, core.options.strict);
  assert.equal(foundation.options.noUncheckedIndexedAccess, true);
  assert.notEqual(
    foundation.options.tsBuildInfoFile,
    core.options.tsBuildInfoFile,
  );
  assert.equal(
    core.projectReferences.some((ref) => {
      return ref.path === join(root, "tsconfig.foundation.json");
    }),
    true,
  );
  assert.equal(
    foundation.fileNames.some((file) => {
      return core.fileNames.includes(file);
    }),
    false,
  );
  write(root, "src/lib/db-raw-rows.ts", 'import "./example";\n');
  rejected(
    guard(root),
    /Foundation modules must not import downstream implementation roots/,
  );
  write(
    root,
    "src/lib/db-raw-rows.ts",
    'export type Downstream = import("./example").Example;\n',
  );
  rejected(
    guard(root),
    /Foundation modules must not import downstream implementation roots/,
  );
});

test("foundation membership loss and overlapping core ownership fail closed", (t) => {
  const root = fixture(t);
  prepare(root);
  changeConfig(root, "tsconfig.foundation.json", (value) => {
    value.include = value.include.filter((file) => {
      return file !== "src/lib/db-raw-rows.ts";
    });
  });
  rejected(guard(root), /missing baseline roots/);
  changeConfig(root, "tsconfig.foundation.json", (value) => {
    value.include.push("src/lib/db-raw-rows.ts");
  });
  changeConfig(root, "tsconfig.core.json", (value) => {
    value.exclude = value.exclude.filter((file) => {
      return file !== "src/lib/db-raw-rows.ts";
    });
  });
  rejected(guard(root), /must belong to exactly one Program/);
});

test("admission preserves compiler isolation and rejects downstream imports", (t) => {
  const root = fixture(t);
  prepare(root);
  const admission = config(root, "tsconfig.admission.json");
  const foundation = config(root, "tsconfig.foundation.json");
  const core = config(root, "tsconfig.core.json");
  assert.equal(admission.options.composite, true);
  assert.equal(admission.options.declaration, true);
  assert.equal(admission.options.emitDeclarationOnly, true);
  assert.equal(admission.options.disableSourceOfProjectReferenceRedirect, true);
  assert.equal(admission.options.strict, true);
  assert.equal(admission.options.noUncheckedIndexedAccess, true);
  assert.equal(
    new Set(
      [foundation, admission, core].map((project) => {
        return project.options.tsBuildInfoFile;
      }),
    ).size,
    3,
  );
  for (const name of [
    "tsconfig.core.json",
    "tsconfig.routes.json",
    "tsconfig.bootstrap.json",
    "tsconfig.tests.json",
    "tsconfig.bootstrap-wiring.json",
  ]) {
    const downstream = config(root, name);
    for (const upstream of ["foundation", "admission"]) {
      assert.ok(
        downstream.projectReferences.some((ref) => {
          return ref.path === join(root, `tsconfig.${upstream}.json`);
        }),
      );
    }
    assert.ok(
      admission.fileNames.every((file) => {
        return !downstream.fileNames.includes(file);
      }),
    );
  }
  write(root, "src/lib/strip-markdown.ts", 'export * from "./db-raw-rows";\n');
  accepted(guard(root));
  for (const content of [
    'import "./example";\n',
    'export * from "./example";\n',
    'export type Downstream = import("./example").Example;\n',
    'export const load = () => import("./example");\n',
  ]) {
    write(root, "src/lib/strip-markdown.ts", content);
    rejected(
      guard(root),
      /Admission modules must not import downstream implementation roots/,
    );
  }
  write(root, "src/lib/strip-markdown.ts", "export {};\n");
  write(root, "src/lib/db-raw-rows.ts", 'import "./strip-markdown";\n');
  rejected(
    guard(root),
    /Foundation modules must not import downstream implementation roots/,
  );
});

test("admission membership loss and duplicate ownership fail closed", (t) => {
  const root = fixture(t);
  prepare(root);
  changeConfig(root, "tsconfig.admission.json", (value) => {
    value.include = value.include.filter((file) => {
      return file !== "src/lib/strip-markdown.ts";
    });
  });
  rejected(guard(root), /missing baseline roots/);
  changeConfig(root, "tsconfig.admission.json", (value) => {
    value.include.push("src/lib/strip-markdown.ts");
  });
  changeConfig(root, "tsconfig.core.json", (value) => {
    value.exclude = value.exclude.filter((file) => {
      return file !== "src/lib/strip-markdown.ts";
    });
  });
  rejected(guard(root), /must belong to exactly one Program/);
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
  validateTestProjects(root);
  const updated = owners();
  assert.ok(updated.has(join(root, added)));
  for (const [file, owner] of original) {
    assert.equal(updated.get(file), owner);
  }
  const renamed = "src/__tests__/renamed.test.ts";
  renameSync(join(root, added), join(root, renamed));
  assert.throws(() => {
    validateTestProjects(root);
  }, /Stale or modified test project/);
  prepare(root);
  assert.ok(!owners().has(join(root, added)));
  assert.ok(owners().has(join(root, renamed)));
  rmSync(join(root, renamed));
  assert.throws(() => {
    validateTestProjects(root);
  }, /Stale or modified test project/);
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
    assert.throws(() => {
      validateTestProjects(root);
    }, /Stale or modified test project/);
    prepare(root);
  }
  write(root, name, "{broken");
  assert.throws(() => {
    validateTestProjects(root);
  }, /Stale or modified test project/);
  prepare(root);
  rmSync(join(root, name));
  assert.throws(() => {
    validateTestProjects(root);
  }, /ENOENT/);
  prepare(root);
  validateTestProjects(root);
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
    assert.throws(() => {
      prepareTestProjects(root);
    }, /strict|ENOENT|Duplicate|rootDir|references/);
    assert.throws(() => {
      validateTestProjects(root);
    }, /strict|ENOENT|Duplicate|rootDir|references/);
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

test("aggregate entrypoint preserves stage order and stops at a failed command", (t) => {
  const root = fixture(t);
  copyFileSync(
    join(import.meta.dirname, "check-types.sh"),
    join(root, "scripts/check-types.sh"),
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const command of ["node", "pnpm", "tsc"]) {
    const path = join(bin, command);
    writeFileSync(
      path,
      `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync("commands.jsonl", JSON.stringify({ command: "${command}", args }) + "\\n");
if (args.includes("../../scripts/tsc-checkers.mjs")) process.stdout.write("2");
if (args.includes(process.env.TYPECHECK_FIXTURE_FAIL)) process.exit(17);
`,
    );
    chmodSync(path, 0o755);
  }
  const invoke = (stage, failure = "") => {
    return spawnSync("bash", [join(root, "scripts/check-types.sh"), stage], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TYPECHECK_FIXTURE_FAIL: failure,
      },
    });
  };
  const commands = () => {
    return readFileSync(join(root, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        return JSON.parse(line);
      });
  };
  const projects = () => {
    return commands()
      .filter(({ command }) => {
        return command === "tsc";
      })
      .map(({ args }) => {
        assert.deepEqual(args.slice(-2), ["--checkers", "2"]);
        return args[1];
      });
  };
  const success = invoke("all");
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(projects(), [
    "tsconfig.foundation.json",
    "tsconfig.admission.json",
    "tsconfig.core.json",
    "tsconfig.routes.json",
    "tsconfig.bootstrap.json",
    ".typecheck/tsconfig.tests-0.json",
    ".typecheck/tsconfig.tests-1.json",
    ".typecheck/tsconfig.tests-2.json",
    "tsconfig.bootstrap-wiring.json",
  ]);
  assert.deepEqual(commands().slice(0, 5), [
    {
      command: "pnpm",
      args: ["--filter", "@okouai/pi-agent-runtime", "run", "build"],
    },
    {
      command: "node",
      args: ["--test", "scripts/typecheck-projects.node-test.mjs"],
    },
    { command: "node", args: ["scripts/prepare-typecheck-tests.mjs"] },
    { command: "node", args: ["scripts/check-typecheck-boundaries.mjs"] },
    { command: "pnpm", args: ["run", "check-types:gateways"] },
  ]);
  rmSync(join(root, "commands.jsonl"));
  const failure = invoke("all", "tsconfig.routes.json");
  assert.equal(failure.status, 17, failure.stderr);
  assert.deepEqual(projects(), [
    "tsconfig.foundation.json",
    "tsconfig.admission.json",
    "tsconfig.core.json",
    "tsconfig.routes.json",
  ]);
  rmSync(join(root, "commands.jsonl"));
  const foundationFailure = invoke("all", "tsconfig.foundation.json");
  assert.equal(foundationFailure.status, 17, foundationFailure.stderr);
  assert.deepEqual(projects(), ["tsconfig.foundation.json"]);
  assert.match(foundationFailure.stdout, /Type check phase: foundation/);
  assert.doesNotMatch(foundationFailure.stdout, /Type check phase: core/);
  rmSync(join(root, "commands.jsonl"));
  const admissionFailure = invoke("all", "tsconfig.admission.json");
  assert.equal(admissionFailure.status, 17, admissionFailure.stderr);
  assert.deepEqual(projects(), [
    "tsconfig.foundation.json",
    "tsconfig.admission.json",
  ]);
  assert.match(admissionFailure.stdout, /Type check phase: admission/);
  assert.doesNotMatch(admissionFailure.stdout, /Type check phase: core/);
  rmSync(join(root, "commands.jsonl"));
  const tests = invoke("tests");
  assert.equal(tests.status, 0, tests.stderr);
  assert.deepEqual(commands()[0], {
    command: "node",
    args: ["scripts/prepare-typecheck-tests.mjs"],
  });
  assert.deepEqual(projects(), [
    ".typecheck/tsconfig.tests-0.json",
    ".typecheck/tsconfig.tests-1.json",
    ".typecheck/tsconfig.tests-2.json",
  ]);
  for (const index of [0, 1, 2]) {
    rmSync(join(root, "commands.jsonl"));
    const testFailure = invoke(
      "all",
      `.typecheck/tsconfig.tests-${index}.json`,
    );
    assert.equal(testFailure.status, 17, testFailure.stderr);
    assert.deepEqual(
      projects().slice(-index - 1),
      [0, 1, 2].slice(0, index + 1).map((group) => {
        return `.typecheck/tsconfig.tests-${group}.json`;
      }),
    );
    assert.doesNotMatch(
      testFailure.stdout,
      /Type check phase: bootstrap-wiring/,
    );
  }
});
