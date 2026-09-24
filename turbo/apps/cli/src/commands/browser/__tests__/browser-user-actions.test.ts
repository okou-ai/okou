import { HttpResponse, http, ws } from "msw";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server } from "../../../mocks/server";
import { browserCommand } from "../index";

const spawnSyncMock = vi.hoisted(() => {
  return vi.fn();
});
vi.mock("node:child_process", () => {
  return { spawnSync: spawnSyncMock };
});

const CDP_URL = "wss://capture.browser-use.com/?token=secret-cdp-token";
const ACTION_URL =
  "https://app.okou.ai/browser/actions/opaque-action-token?agentId=10000000-0000-4000-a000-000000000001&threadId=20000000-0000-4000-a000-000000000002";
const THREAD_ID = "20000000-0000-4000-a000-000000000002";
const AGENT_ID = "10000000-0000-4000-a000-000000000001";
const cdp = ws.link(CDP_URL);

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

interface CdpOptions {
  readonly selectorCount?: number;
  readonly nodeName?: string;
  readonly oversizedResponseFor?: string;
  readonly pageMarkerMatches?: boolean;
  readonly pageMarkerResponses?: readonly boolean[];
  readonly refObjectIds?: readonly string[];
}

interface CdpState {
  pageMarkerIndex: number;
  refIndex: number;
}

function runtimeCallFunctionResult(
  command: CdpCommand,
  options: CdpOptions,
  state: CdpState,
): unknown {
  const functionDeclaration = String(command.params.functionDeclaration ?? "");
  if (
    functionDeclaration.includes("querySelectorAll") ||
    functionDeclaration.includes("document.evaluate")
  ) {
    return options.selectorCount !== undefined && options.selectorCount !== 1
      ? { result: { type: "number", value: options.selectorCount } }
      : {
          result: {
            type: "object",
            subtype: "node",
            objectId: "selector-object",
          },
        };
  }
  if (functionDeclaration.includes("element&&element[key]===value")) {
    const objectId =
      options.refObjectIds?.[state.refIndex] ??
      `ref-object-${state.refIndex + 1}`;
    state.refIndex += 1;
    return { result: { type: "object", subtype: "node", objectId } };
  }
  if (functionDeclaration.includes("this[key]===value")) {
    const value =
      options.pageMarkerResponses?.[state.pageMarkerIndex] ??
      options.pageMarkerMatches ??
      true;
    state.pageMarkerIndex += 1;
    return { result: { type: "boolean", value } };
  }
  return { result: { type: "undefined" } };
}

function cdpCommandResult(
  command: CdpCommand,
  options: CdpOptions,
  state: CdpState,
): unknown {
  if (command.method === "Target.getTargets") {
    return {
      targetInfos: [
        {
          targetId: "page-target",
          type: "page",
          url: "https://example.com/login",
        },
      ],
    };
  }
  if (command.method === "Target.attachToTarget") {
    return { sessionId: "page-session" };
  }
  if (command.method === "Runtime.evaluate") {
    return {
      result: {
        type: "object",
        objectId: "global-object",
      },
    };
  }
  if (command.method === "Runtime.callFunctionOn") {
    return runtimeCallFunctionResult(command, options, state);
  }
  if (command.method === "DOM.describeNode") {
    const objectId = String(command.params.objectId ?? "");
    return {
      node: {
        backendNodeId: objectId.endsWith("2") ? 43 : 42,
        nodeName: options.nodeName ?? "INPUT",
      },
    };
  }
  return {};
}

function okAgentBrowser(data: Readonly<Record<string, unknown>> = {}) {
  return {
    status: 0,
    stdout: JSON.stringify({ success: true, data }),
    stderr: "",
  };
}

function markerResult(script: string): Readonly<Record<string, string>> {
  const kind = script.includes("_field_")
    ? "field"
    : script.includes("_verify_")
      ? "verify"
      : "page";
  return {
    key: `__okou_browser_user_action_${kind}_${"a".repeat(32)}`,
    value: "b".repeat(32),
  };
}

function installAgentBrowser(): void {
  spawnSyncMock.mockImplementation(
    (_command: string, args: readonly string[]) => {
      if (args.at(-2) === "get" && args.at(-1) === "cdp-url") {
        return okAgentBrowser({ cdpUrl: CDP_URL });
      }
      if (args.at(-2) === "eval") {
        const script = String(args.at(-1));
        return okAgentBrowser({
          result: script.includes("Object.defineProperty")
            ? markerResult(script)
            : true,
        });
      }
      return okAgentBrowser();
    },
  );
}

function installCdp(options: CdpOptions = {}): CdpCommand[] {
  const commands: CdpCommand[] = [];
  const state: CdpState = { pageMarkerIndex: 0, refIndex: 0 };
  server.use(
    cdp.addEventListener("connection", ({ client }) => {
      client.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          throw new Error("Expected text CDP command");
        }
        const command = JSON.parse(event.data) as CdpCommand;
        commands.push(command);
        if (command.method === options.oversizedResponseFor) {
          client.send("x".repeat(65 * 1024));
          return;
        }
        const result = cdpCommandResult(command, options, state);
        client.send(JSON.stringify({ id: command.id, result }));
      });
    }),
  );
  return commands;
}

function actionResponse() {
  const base = {
    requestToken: "opaque-action-token",
    state: "pending" as const,
    completedAt: null,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    callbackIds: {
      success: {
        clientEventId: "30000000-0000-4000-a000-000000000003",
        chatThreadSortEventId: "40000000-0000-4000-a000-000000000004",
      },
      cancellation: {
        clientEventId: "50000000-0000-4000-a000-000000000005",
        chatThreadSortEventId: "60000000-0000-4000-a000-000000000006",
      },
    },
  };
  return {
    ...base,
    kind: "input" as const,
    siteOrigin: "https://example.com",
    fields: [
      {
        key: "username",
        label: "Email",
        fieldKind: "username" as const,
        required: true,
        control: { tagName: "INPUT" as const, inputType: "email" as const },
      },
    ],
  };
}

function installCreateRoute(observe: (body: unknown) => void): void {
  server.use(
    http.post(
      "http://localhost:3000/api/browser/user-actions",
      async ({ request }) => {
        observe(await request.json());
        return HttpResponse.json(
          { actionUrl: ACTION_URL, action: actionResponse() },
          { status: 201 },
        );
      },
    ),
  );
}

function inputCommand() {
  return browserCommand.commands.find((command) => {
    return command.name() === "input-request";
  })!;
}

describe("okou browser user-action commands", () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const processExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-run-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    inputCommand().setOptionValue("field", []);
    installAgentBrowser();
  });

  afterEach(() => {
    consoleLog.mockClear();
    consoleError.mockClear();
    processExit.mockClear();
    spawnSyncMock.mockReset();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    processExit.mockRestore();
  });

  it("captures a unique selector and sends only exact target identities", async () => {
    const cdpCommands = installCdp();
    let requestBody: unknown;
    installCreateRoute((body) => {
      requestBody = body;
    });

    await browserCommand.parseAsync([
      "node",
      "okou",
      "input-request",
      "--field",
      JSON.stringify({
        key: "username",
        label: "Email",
        fieldKind: "username",
        required: true,
        target: "#email",
      }),
      "--callback-prompt",
      "Continue after the user enters their email",
    ]);

    expect(requestBody).toStrictEqual({
      kind: "input",
      callbackPrompt: "Continue after the user enters their email",
      pageTargetId: "page-target",
      fields: [
        {
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          backendNodeId: 42,
        },
      ],
    });
    expect(
      cdpCommands.some((command) => {
        return command.method === "DOM.describeNode";
      }),
    ).toBe(true);
    const selectorCall = cdpCommands.find((command) => {
      return (
        command.method === "Runtime.callFunctionOn" &&
        String(command.params.functionDeclaration).includes("querySelectorAll")
      );
    });
    expect(selectorCall?.params.arguments).toStrictEqual([{ value: "#email" }]);
    expect(String(selectorCall?.params.functionDeclaration)).not.toContain(
      "#email",
    );
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(ACTION_URL);
    expect(output).toContain("stop using the Browser in this turn");
    expect(output).not.toContain("#email");
    expect(output).not.toContain("secret-cdp-token");
    expect(output).not.toContain("backendNodeId");
    expect(
      cdpCommands.some((command) => {
        return command.method === "Target.detachFromTarget";
      }),
    ).toBe(true);
  });

  it("captures a number field without converting its semantic kind", async () => {
    installCdp();
    let requestBody: unknown;
    installCreateRoute((body) => {
      requestBody = body;
    });
    await browserCommand.parseAsync([
      "node",
      "okou",
      "input-request",
      "--field",
      JSON.stringify({
        key: "quantity",
        label: "Quantity",
        fieldKind: "number",
        required: false,
        target: "#quantity",
      }),
      "--callback-prompt",
      "Continue after quantity entry",
    ]);
    expect(requestBody).toMatchObject({
      fields: [{ key: "quantity", fieldKind: "number", backendNodeId: 42 }],
    });
    expect(JSON.stringify(requestBody)).not.toContain("#quantity");
  });

  it("resolves an XPath target locally without sending it to the API", async () => {
    const cdpCommands = installCdp();
    let requestBody: unknown;
    installCreateRoute((body) => {
      requestBody = body;
    });

    await browserCommand.parseAsync([
      "node",
      "okou",
      "input-request",
      "--field",
      JSON.stringify({
        key: "username",
        label: "Email",
        fieldKind: "username",
        required: true,
        target: "xpath=//input[@name='email']",
      }),
      "--callback-prompt",
      "Continue",
    ]);

    expect(JSON.stringify(requestBody)).not.toContain("xpath");
    expect(
      cdpCommands.some((command) => {
        return (
          command.method === "Runtime.callFunctionOn" &&
          String(command.params.functionDeclaration).includes(
            "document.evaluate",
          )
        );
      }),
    ).toBe(true);
  });

  it("resolves agent-browser refs in one page before creating the request", async () => {
    const cdpCommands = installCdp({
      refObjectIds: ["ref-object-1", "ref-object-2"],
    });
    let requestBody: unknown;
    installCreateRoute((body) => {
      requestBody = body;
    });

    await browserCommand.parseAsync([
      "node",
      "okou",
      "input-request",
      "--field",
      JSON.stringify({
        key: "username",
        label: "Email",
        fieldKind: "username",
        required: true,
        target: "@e1",
      }),
      "--field",
      JSON.stringify({
        key: "password",
        label: "Password",
        fieldKind: "password",
        required: true,
        target: "ref=e2",
      }),
      "--callback-prompt",
      "Continue after the user enters their credentials",
    ]);

    expect(requestBody).toMatchObject({
      pageTargetId: "page-target",
      fields: [
        { key: "username", backendNodeId: 42 },
        { key: "password", backendNodeId: 43 },
      ],
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "okou-browser", "--json", "focus", "@e1"],
      expect.any(Object),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "okou-browser", "--json", "focus", "@e2"],
      expect.any(Object),
    );
    expect(
      cdpCommands.filter((command) => {
        return (
          command.method === "Runtime.callFunctionOn" &&
          String(command.params.objectId).startsWith("ref-object")
        );
      }),
    ).toHaveLength(2);
  });

  it("rejects invalid field metadata before Browser or API access", async () => {
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "not-a-kind",
          required: true,
          target: "#email",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(consoleLog.mock.calls.flat().join("\n")).not.toContain(ACTION_URL);
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain("#email");
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "--field 1: fieldKind must be text, username, password, one_time_code, number",
    );
  });

  it("identifies the malformed --field position without echoing its value", async () => {
    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "@e1",
        }),
        "--field",
        "{private-target",
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    const output = consoleError.mock.calls.flat().join("\n");
    expect(output).toContain("--field 2 must be valid JSON");
    expect(output).not.toContain("private-target");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("reports a missing callback prompt as JSON before Browser access", async () => {
    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "@e1",
        }),
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: "BROWSER_INPUT_INVALID_REQUEST",
        message: "--callback-prompt must be 1-200 characters",
        retryable: false,
      },
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate field keys before Browser access", async () => {
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });
    const field = JSON.stringify({
      key: "username",
      label: "Email",
      fieldKind: "username",
      required: true,
      target: "#email",
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        field,
        "--field",
        field,
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects more than eight fields before Browser access", async () => {
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });
    const args = ["node", "okou", "input-request"];
    for (let index = 0; index < 9; index += 1) {
      args.push(
        "--field",
        JSON.stringify({
          key: `field-${index}`,
          label: `Field ${index}`,
          fieldKind: "text",
          required: true,
          target: `#field-${index}`,
        }),
      );
    }
    args.push("--callback-prompt", "Continue");

    await expect(browserCommand.parseAsync(args)).rejects.toThrow(
      "process.exit called",
    );

    expect(apiRequests).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("fails closed when a selector is ambiguous", async () => {
    installCdp({ selectorCount: 2 });
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "@e1",
        }),
        "--field",
        JSON.stringify({
          key: "password",
          label: "Password",
          fieldKind: "password",
          required: true,
          target: "#sensitive-field",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "--field 2: the target matched 2 controls",
    );
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(
      "#sensitive-field",
    );
  });

  it("distinguishes a missing selector from an ambiguous one", async () => {
    installCdp({ selectorCount: 0 });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "#private-selector",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    const output = consoleError.mock.calls.flat().join("\n");
    expect(output).toContain("--field 1: the target matched no controls");
    expect(output).not.toContain("#private-selector");
  });

  it("fails closed when two fields resolve to the same control", async () => {
    installCdp();
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "#email",
        }),
        "--field",
        JSON.stringify({
          key: "password",
          label: "Password",
          fieldKind: "password",
          required: true,
          target: "#same-control",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "--field 2 targets the same control as --field 1",
    );
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(
      "#same-control",
    );
  });

  it("rejects frame and unsupported nodes before API creation", async () => {
    installCdp({ nodeName: "IFRAME" });
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "@e1",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "top-level input and textarea",
    );
  });

  it("fails when the agent-browser page cannot be identified", async () => {
    installCdp({ pageMarkerMatches: false });
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "#email",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "could not be identified",
    );
  });

  it("fails closed on an oversized CDP response", async () => {
    installCdp({ oversizedResponseFor: "Target.getTargets" });
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "#email",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(
      "secret-cdp-token",
    );
  });

  it("fails before API creation when agent-browser inspection fails", async () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: `failed for ${CDP_URL}`,
    });
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "#email",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(CDP_URL);
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain("#email");
  });

  it("identifies an expired element ref without printing agent-browser stderr", async () => {
    installCdp();
    spawnSyncMock.mockImplementation(
      (_command: string, args: readonly string[]) => {
        if (args.at(-2) === "focus") {
          return {
            status: 1,
            stdout: "",
            stderr: "private-browser-page-data",
          };
        }
        if (args.at(-2) === "get" && args.at(-1) === "cdp-url") {
          return okAgentBrowser({ cdpUrl: CDP_URL });
        }
        if (args.at(-2) === "eval") {
          return okAgentBrowser({
            result: markerResult(String(args.at(-1))),
          });
        }
        return okAgentBrowser();
      },
    );

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "@e1",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    const output = consoleError.mock.calls.flat().join("\n");
    expect(output).toContain(
      "--field 1: the Browser element reference could not be focused",
    );
    expect(output).toContain("Take a new agent-browser snapshot");
    expect(output).not.toContain("private-browser-page-data");
  });

  it("does not extend the capture deadline for fallback cleanup", async () => {
    let nowCalls = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls <= 2 ? 1_000 : 32_000;
    });
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    try {
      await expect(
        browserCommand.parseAsync([
          "node",
          "okou",
          "input-request",
          "--field",
          JSON.stringify({
            key: "username",
            label: "Email",
            fieldKind: "username",
            required: true,
            target: "#email",
          }),
          "--callback-prompt",
          "Continue",
        ]),
      ).rejects.toThrow("process.exit called");
    } finally {
      dateNow.mockRestore();
    }

    expect(apiRequests).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls.flat().join("\n")).toContain("timed out");
  });

  it("fails before API creation when the selected document navigates", async () => {
    installCdp({ pageMarkerResponses: [true, true, false] });
    let apiRequests = 0;
    installCreateRoute(() => {
      apiRequests += 1;
    });

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "#email",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "changed during capture",
    );
  });

  it("emits no action URL when the API feature is disabled", async () => {
    installCdp();
    server.use(
      http.post("http://localhost:3000/api/browser/user-actions", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Browser native input is not enabled",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "#email",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(consoleLog.mock.calls.flat().join("\n")).not.toContain(ACTION_URL);
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(
      "secret-cdp-token",
    );
    expect(consoleError.mock.calls.flat().join("\n")).toContain("FORBIDDEN");
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Use direct Browser takeover",
    );
  });

  it("shows the API's safe field mismatch and a corrective next action", async () => {
    installCdp();
    server.use(
      http.post("http://localhost:3000/api/browser/user-actions", () => {
        return HttpResponse.json(
          {
            error: {
              code: "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL",
              message:
                "--field 1: fieldKind 'password' does not match the observed input type 'email'; use text or username",
            },
          },
          { status: 409 },
        );
      }),
    );

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "password",
          label: "Password",
          fieldKind: "password",
          required: true,
          target: "#private-selector",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    const output = consoleError.mock.calls.flat().join("\n");
    expect(output).toContain("BROWSER_USER_ACTION_UNSUPPORTED_CONTROL");
    expect(output).toContain("--field 1: fieldKind 'password'");
    expect(output).toContain(
      "Choose a supported control and matching fieldKind",
    );
    expect(output).not.toContain("#private-selector");
    expect(consoleLog.mock.calls.flat().join("\n")).not.toContain(ACTION_URL);
  });

  it("tells the agent to reconnect when its run has no live Browser", async () => {
    installCdp();
    server.use(
      http.post("http://localhost:3000/api/browser/user-actions", () => {
        return HttpResponse.json(
          {
            error: {
              code: "BROWSER_USER_ACTION_BROWSER_NOT_LIVE",
              message: "The current chat run has no live managed Browser",
            },
          },
          { status: 409 },
        );
      }),
    );

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "@e1",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    const output = consoleError.mock.calls.flat().join("\n");
    expect(output).toContain("BROWSER_USER_ACTION_BROWSER_NOT_LIVE");
    expect(output).toContain("Run `okou browser use`");
    expect(consoleLog.mock.calls.flat().join("\n")).not.toContain(ACTION_URL);
  });

  it("gives page-specific guidance for an unsupported Browser page", async () => {
    installCdp();
    server.use(
      http.post("http://localhost:3000/api/browser/user-actions", () => {
        return HttpResponse.json(
          {
            error: {
              code: "BROWSER_USER_ACTION_UNSUPPORTED_PAGE",
              message: "The selected Browser page is not an HTTP or HTTPS page",
            },
          },
          { status: 409 },
        );
      }),
    );

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "@e1",
        }),
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    const output = consoleError.mock.calls.flat().join("\n");
    expect(output).toContain("BROWSER_USER_ACTION_UNSUPPORTED_PAGE");
    expect(output).toContain("Open an HTTP or HTTPS page");
    expect(output).not.toContain(ACTION_URL);
  });

  it("emits a single structured retryable error under --json", async () => {
    installCdp();
    server.use(
      http.post("http://localhost:3000/api/browser/user-actions", () => {
        return HttpResponse.json(
          {
            error: {
              code: "BROWSER_USE_TIMEOUT",
              message: "Provider token should not be printed: private-token",
            },
          },
          { status: 503 },
        );
      }),
    );

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "#private-selector",
        }),
        "--callback-prompt",
        "Continue",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toStrictEqual({
      error: {
        code: "BROWSER_USE_TIMEOUT",
        message: "The managed Browser inspection timed out",
        nextAction:
          "Check that the Browser is live, then retry this request once.",
        retryable: true,
      },
    });
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(
      "private-token",
    );
  });

  it.each([
    {
      code: "BROWSER_USE_NOT_CONFIGURED",
      status: 503,
      providerMessage: "Managed browser provider is not configured",
      message: "Managed Browser access is not configured",
      nextAction:
        "Stop this request and ask the Okou team to configure managed Browser access.",
    },
    {
      code: "BROWSER_USE_OUTPUT_TOO_LARGE",
      status: 502,
      providerMessage: "Managed browser provider response is too large",
      message:
        "The managed Browser provider response exceeded the supported size",
      nextAction:
        "Stop this request and ask the Okou team to inspect the Browser provider response.",
    },
  ])("stops on a managed Browser provider failure: $code", async (failure) => {
    installCdp();
    server.use(
      http.post("http://localhost:3000/api/browser/user-actions", () => {
        return HttpResponse.json(
          {
            error: {
              code: failure.code,
              message: failure.providerMessage,
            },
          },
          { status: failure.status },
        );
      }),
    );

    await expect(
      browserCommand.parseAsync([
        "node",
        "okou",
        "input-request",
        "--field",
        JSON.stringify({
          key: "username",
          label: "Email",
          fieldKind: "username",
          required: true,
          target: "@e1",
        }),
        "--callback-prompt",
        "Continue",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toStrictEqual({
      error: {
        code: failure.code,
        message: failure.message,
        nextAction: failure.nextAction,
        retryable: false,
      },
    });
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
