# Okou CLI Testing

## Principle

The private CLI package exposes only the canonical `okou` entry point. Command
tests are integration tests that enter through Commander with
`command.parseAsync()`.

- Mock the Web API with MSW.
- Keep command parsing, validation, formatting, and filesystem behavior real.
- Use temporary directories for filesystem state.
- Do not mock internal CLI modules.

The retired `vm0` binary and its commands are not compatibility surfaces and
must not be recreated in tests.

## Test location

Place command tests in a neighboring `__tests__/` directory. A command file and
its test should have matching names:

```text
src/commands/
└── search/
    ├── index.ts
    └── __tests__/
        └── index.test.ts
```

## Authentication and routing

Product CLI requests read `OKOU_TOKEN` and nothing else. `getToken()` in
`src/lib/api/config.ts` delegates to `getOkouToken()` in `src/lib/okou-env.ts`,
which reads only `OKOU_TOKEN`. Routing reads only `OKOU_API_BACKEND_URL`; when
it is unset or empty, the CLI defaults to `https://api.okou.ai`. A configured
host without a protocol receives `https://`, while an explicit protocol and
trailing slash are preserved.

Set the canonical token explicitly together with the API URL:

```typescript
beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "test-okou-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
```

Do not create a local authentication config file or mock the config module.
Tests for missing authentication should leave `OKOU_TOKEN` unset and assert the
resulting guidance.

## Command integration pattern

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchCommand } from "../index";

describe("okou search --source agent-session", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    searchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
  });

  it("prints both local agent session locations", async () => {
    await searchCommand.parseAsync([
      "node",
      "okou",
      "find the failed tool call",
      "--source",
      "agent-session",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("/home/user/.claude/projects/");
    expect(output).toContain("/home/user/.codex/sessions/");
  });
});
```

## External boundaries

Mock only dependencies outside the CLI process:

- HTTP calls through MSW
- third-party SDKs that perform external I/O
- process exit and console output when required to observe command behavior

Avoid mocking validators, domain functions, API configuration, serializers, or
other internal modules. Enter through the command and observe output, exit code,
HTTP request, and filesystem changes.

## Filesystem behavior

Use the real filesystem under a temporary directory:

```typescript
const tempDir = mkdtempSync(path.join(os.tmpdir(), "okou-cli-test-"));
const previousCwd = process.cwd();
process.chdir(tempDir);

try {
  await command.parseAsync(["node", "okou", "..."]);
} finally {
  process.chdir(previousCwd);
  rmSync(tempDir, { recursive: true, force: true });
}
```

## Interactive commands

Use `prompts.inject()` to supply responses in order. This exercises the real
prompt integration while keeping the test deterministic. Always restore TTY
properties and injected state during teardown.

## Error behavior

API failures should be represented with MSW responses and asserted through the
command's user-visible error and exit code. Missing-token tests should verify
the `OKOU_TOKEN` setup guidance; present-but-rejected token tests should verify
the invalid-or-expired guidance.

## SSH Deadline Exception

The hung-helper cases in `src/commands/ssh/__tests__/index.test.ts` and
`src/commands/ssh/__tests__/files.test.ts` are a narrow exception to the
fake-timer ban. They exercise the command's 65-second and 15-minute process
deadlines through the CLI entry point. These tests fake only `setTimeout` and
`clearTimeout`, leave other timers real, and assert the observable failure
result after the deadline. Keep the exception limited to those two cases;
ordinary asynchronous CLI tests should synchronize on a request, process, or
file outcome instead of advancing a clock.

## What belongs elsewhere

- API route behavior belongs in API integration tests.
- Multi-service lifecycle behavior belongs in product-surface E2E tests.
- Pure internal unit tests are reserved for security-critical logic,
  algorithmically complex parsers, or state-transition matrices.

See [CLI and Runner E2E Testing](./cli-e2e-testing.md) for the deployed-test
boundary.
