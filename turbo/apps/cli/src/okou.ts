// Okou CLI entry point - standalone binary for Okou platform commands
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { instrumentCommand } from "./sentry-command.js";
import { configureGlobalProxyFromEnv } from "./lib/network/proxy.js";
import {
  decodeSandboxTokenPayload,
  type SandboxTokenPayload,
} from "./lib/api/sandbox-token.js";
import { getOkouToken } from "./lib/okou-env.js";
import { introVideoCatalogCommand } from "./commands/__intro-video-catalog.js";
import { introVideoAgentCommand } from "./commands/__intro-video-agent.js";
import { artifactCommand } from "./commands/artifact/index.js";

interface CommandDefinition {
  name: string;
  description: string;
  load: () => Promise<Command>;
}

/**
 * Map of command names to the capability required to see them.
 * Commands not in this map are hidden when OKOU_TOKEN is active.
 * Use an array when a top-level command has subcommands with different
 * capability gates and any one of them should make the command visible.
 * Use `null` for commands that should always be visible in sandbox.
 */
const COMMAND_CAPABILITY_MAP: Record<
  string,
  string | readonly string[] | null
> = {
  "__agent-loop": null,
  agent: "agent:read",
  workflow: "agent:read",
  connector: ["connector:read", "connector:write"],
  mcp: "connector:read",
  ssh: ["ssh:read", "ssh:write"],
  mail: "connector:read",
  doctor: null,
  credit: ["billing:read", "billing:write"],
  upgrade: null,
  model: null,
  "model-provider": null,
  search: null,
  chat: [
    "chat-event:read",
    "chat-event:write",
    "chat-thread:read",
    "chat-thread:write",
  ],
  resource: null,
  github: ["github:read", "github:write"],
  slack: ["slack:read", "slack:write"],
  feishu: "feishu:write",
  lark: "lark:write",
  teams: "teams:write",
  telegram: ["telegram:read", "telegram:write"],
  phone: ["phone:read", "phone:write"],
  whoami: null,
  "computer-use": "computer-use:write",
  browser: ["browser:read", "browser:write"],
  intro: null,
  generate: null,
  web: null,
  video: null,
  host: ["host:read", "host:write"],
  artifact: ["artifact:read", "artifact:write", "file:read"],
  presentation: null,
  "presentation-template": "presentation-template:write",
  maps: "maps:read",
  weather: "weather:read",
  scrape: "scrape:read",
  "people-search": "people-search:read",
  "web-search": "web-search:read",
  social: "social:read",
  "image-recognition": "image-recognition:write",
  finance: "finance:read",
  seo: "seo:read",
  banking: "banking:read",
};

const RUN_ONLY_COMMANDS = new Set(["mcp", "ssh", "image-recognition"]);

const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  {
    name: "artifact",
    description:
      "Read or set an owned artifact's visibility and return its URL",
    load: async () => {
      return artifactCommand;
    },
  },
  {
    name: "ssh",
    description: "List authorized SSH hosts and execute remote commands",
    load: async () => {
      return (await import("./commands/ssh")).sshCommand;
    },
  },
  {
    name: "__agent-loop",
    description: "Internal sandbox agent loop",
    load: async () => {
      return (await import("./commands/__agent-loop")).agentLoopCommand;
    },
  },
  {
    name: "__intro-video-catalog",
    description: "Internal public HeyGen catalog discovery for Intro Video",
    load: async () => {
      return introVideoCatalogCommand;
    },
  },
  {
    name: "__intro-video-agent",
    description: "Internal managed HeyGen Video Agent submission and status",
    load: async () => {
      return introVideoAgentCommand;
    },
  },
  {
    name: "__intro-video-presenter",
    description: "Internal Intro Video presenter renderer",
    load: async () => {
      return (await import("./commands/__intro-video-presenter"))
        .introVideoPresenterCommand;
    },
  },
  {
    name: "__intro-video-voice",
    description: "Internal Intro Video HeyGen narration renderer",
    load: async () => {
      return (await import("./commands/__intro-video-voice"))
        .introVideoVoiceCommand;
    },
  },
  {
    name: "model",
    description: "List available models and model-switching guidance",
    load: async () => {
      return (await import("./commands/model")).modelCommand;
    },
  },
  {
    name: "model-provider",
    description: "Inspect model provider routing",
    load: async () => {
      return (await import("./commands/model-provider")).modelProviderCommand;
    },
  },
  {
    name: "agent",
    description: "View or manage agents",
    load: async () => {
      return (await import("./commands/agent")).agentCommand;
    },
  },
  {
    name: "connector",
    description: "Check third-party service connections (GitHub, Slack, etc.)",
    load: async () => {
      return (await import("./commands/connector")).connectorCommand;
    },
  },
  {
    name: "mcp",
    description: "Use MCP connectors authorized for this Agent",
    load: async () => {
      return (await import("./commands/mcp")).mcpCommand;
    },
  },
  {
    name: "mail",
    description: "Review and send mail through Gmail or Outlook Mail",
    load: async () => {
      return (await import("./commands/mail")).mailCommand;
    },
  },
  {
    name: "credit",
    description: "View or buy credits",
    load: async () => {
      return (await import("./commands/credit")).creditCommand;
    },
  },
  {
    name: "upgrade",
    description: "Create a workspace plan upgrade link",
    load: async () => {
      return (await import("./commands/upgrade")).upgradeCommand;
    },
  },
  {
    name: "doctor",
    description:
      "Diagnose runtime issues (connector health, permission denials)",
    load: async () => {
      return (await import("./commands/doctor")).doctorCommand;
    },
  },
  {
    name: "github",
    description: "Upload and download GitHub files",
    load: async () => {
      return (await import("./commands/github")).githubCommand;
    },
  },
  {
    name: "slack",
    description:
      "List channels, read history, send messages, and transfer files as the Slack bot",
    load: async () => {
      return (await import("./commands/slack")).slackCommand;
    },
  },
  {
    name: "lark",
    description: "Send messages and transfer files through Lark",
    load: async () => {
      return (await import("./commands/feishu")).createFeishuCommand("lark");
    },
  },
  {
    name: "feishu",
    description: "Send messages to Feishu as an organization bot",
    load: async () => {
      return (await import("./commands/feishu")).feishuCommand;
    },
  },
  {
    name: "teams",
    description:
      "Send Microsoft Teams messages, upload files, and download files",
    load: async () => {
      return (await import("./commands/teams")).teamsCommand;
    },
  },
  {
    name: "telegram",
    description:
      "Inspect bots, send messages, upload files, and download files from Telegram",
    load: async () => {
      return (await import("./commands/telegram")).telegramCommand;
    },
  },
  {
    name: "phone",
    description: "Send AgentPhone messages, upload files, and download media",
    load: async () => {
      return (await import("./commands/phone")).phoneCommand;
    },
  },
  {
    name: "search",
    description: "Search chat or locate sources for direct analysis",
    load: async () => {
      return (await import("./commands/search")).searchCommand;
    },
  },
  {
    name: "chat",
    description: "Manage the current web chat thread",
    load: async () => {
      return (await import("./commands/chat")).chatCommand;
    },
  },
  {
    name: "resource",
    description: "Pull registry resources from private R2-backed archives",
    load: async () => {
      return (await import("./commands/resource")).resourceCommand;
    },
  },
  {
    name: "whoami",
    description: "Show agent identity, run ID, and capabilities",
    load: async () => {
      return (await import("./commands/whoami")).whoamiCommand;
    },
  },
  {
    name: "intro",
    description: "Print Okou's self-introduction and capability guide",
    load: async () => {
      return (await import("./commands/intro")).introCommand;
    },
  },
  {
    name: "workflow",
    description: "Manage workflows",
    load: async () => {
      return (await import("./commands/workflow")).workflowCommand;
    },
  },
  {
    name: "computer-use",
    description: "Desktop app computer use through Okou CLI",
    load: async () => {
      return (await import("./commands/computer-use")).computerUseCommand;
    },
  },
  {
    name: "browser",
    description: "Managed remote browser sessions for agent-browser",
    load: async () => {
      return (await import("./commands/browser")).browserCommand;
    },
  },
  {
    name: "generate",
    description:
      "Generate assets via Okou's built-in pipelines or get connector skill-invocation guidance",
    load: async () => {
      return (await import("./commands/generate")).generateCommand;
    },
  },
  {
    name: "web",
    description: "Upload and download files via the web chat endpoint",
    load: async () => {
      return (await import("./commands/web")).webCommand;
    },
  },
  {
    name: "video",
    description: "Video processing utilities",
    load: async () => {
      return (await import("./commands/video")).videoCommand;
    },
  },
  {
    name: "host",
    description: "Publish static sites and clone owned hosted site files",
    load: async () => {
      return (await import("./commands/host")).hostCommand;
    },
  },
  {
    name: "presentation",
    description: "Render presentations to page images",
    load: async () => {
      return (await import("./commands/presentation")).presentationCommand;
    },
  },
  {
    name: "presentation-template",
    description: "Publish presentation templates extracted from a deck",
    load: async () => {
      return (await import("./commands/presentation-template"))
        .presentationTemplateCommand;
    },
  },
  {
    name: "user-template",
    description: "Publish custom templates compiled from a file you uploaded",
    load: async () => {
      return (await import("./commands/user-template")).userTemplateCommand;
    },
  },
  {
    name: "maps",
    description: "Use managed Okou maps services",
    load: async () => {
      return (await import("./commands/maps")).mapsCommand;
    },
  },
  {
    name: "weather",
    description: "Use managed Okou weather services",
    load: async () => {
      return (await import("./commands/weather")).weatherCommand;
    },
  },
  {
    name: "scrape",
    description: "Scrape public web pages through managed Okou scrape",
    load: async () => {
      return (await import("./commands/scrape")).scrapeCommand;
    },
  },
  {
    name: "people-search",
    description: "Find professionals through managed Okou people search",
    load: async () => {
      return (await import("./commands/people-search")).peopleSearchCommand;
    },
  },
  {
    name: "web-search",
    description: "Search the public web through managed Okou web search",
    load: async () => {
      return (await import("./commands/web-search")).webSearchCommand;
    },
  },
  {
    name: "social",
    description: "Retrieve public social data through managed Okou services",
    load: async () => {
      return (await import("./commands/social")).socialCommand;
    },
  },
  {
    name: "image-recognition",
    description: "Recognize one image through a managed multimodal model",
    load: async () => {
      return (await import("./commands/image-recognition"))
        .imageRecognitionCommand;
    },
  },
  {
    name: "finance",
    description: "Query financial instruments through managed Okou finance",
    load: async () => {
      return (await import("./commands/finance")).financeCommand;
    },
  },
  {
    name: "seo",
    description: "Query managed SEO data through DataForSEO",
    load: async () => {
      return (await import("./commands/seo")).seoCommand;
    },
  },
  {
    name: "banking",
    description: "Use managed Okou banking services",
    load: async () => {
      return (await import("./commands/banking")).bankingCommand;
    },
  },
];

const COMMAND_DEFINITION_BY_NAME = new Map(
  COMMAND_DEFINITIONS.map((definition) => {
    return [definition.name, definition];
  }),
);

function createCommandStub(definition: CommandDefinition): Command {
  return new Command(definition.name).description(definition.description);
}

function buildDefaultCommands(): Command[] {
  return COMMAND_DEFINITIONS.map(createCommandStub);
}

function shouldHideCommand(
  name: string,
  payload: SandboxTokenPayload | undefined,
): boolean {
  if (name.startsWith("__")) return true;
  if (!payload) return RUN_ONLY_COMMANDS.has(name);
  const requiredCap = COMMAND_CAPABILITY_MAP[name];
  if (requiredCap === undefined) return true;
  if (requiredCap === null) return false;
  if (typeof requiredCap !== "string") {
    return !requiredCap.some((capability) => {
      return payload.capabilities.includes(capability);
    });
  }
  return !payload.capabilities.includes(requiredCap);
}

function addCommandWithVisibility(
  prog: Command,
  cmd: Command,
  payload: SandboxTokenPayload | undefined,
): void {
  const hidden = shouldHideCommand(cmd.name(), payload);
  prog.addCommand(cmd, hidden ? { hidden: true } : {});
}

function getNonOptionArgs(argv: string[]): string[] {
  const args: string[] = [];

  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    args.push(arg);
  }

  return args;
}

function getRequestedCommandName(argv = process.argv): string | undefined {
  const [firstArg, secondArg] = getNonOptionArgs(argv);

  if (!firstArg) {
    return undefined;
  }

  if (firstArg === "help") {
    return secondArg;
  }

  return firstArg;
}

async function loadRequestedCommand(
  name: string | undefined,
): Promise<Command | undefined> {
  if (!name) {
    return undefined;
  }

  return COMMAND_DEFINITION_BY_NAME.get(name)?.load();
}

export async function registerRequestedCommand(
  prog: Command,
  argv: string[] = process.argv,
): Promise<void> {
  const requestedCommandName = getRequestedCommandName(argv);
  const requestedCommand = await loadRequestedCommand(requestedCommandName);
  registerCommands(prog, requestedCommand ? [requestedCommand] : undefined);

  if (
    getNonOptionArgs(argv)[0] === "help" &&
    requestedCommandName !== undefined &&
    requestedCommand === undefined
  ) {
    prog
      .command("help <command>", { hidden: true })
      .action((commandName: string) => {
        prog.error(`error: unknown command '${commandName}'`, {
          code: "commander.unknownCommand",
        });
      });
  }
}

function commandExampleIfVisible(
  name: string,
  example: string,
  payload: SandboxTokenPayload | undefined,
): string[] {
  return shouldHideCommand(name, payload) ? [] : [example];
}

export function buildHelpText(
  payload: SandboxTokenPayload | undefined = decodeSandboxTokenPayload(),
): string {
  const canReadHost = !payload || payload.capabilities.includes("host:read");
  const canWriteHost = !payload || payload.capabilities.includes("host:write");
  const examples = [
    "  Check a connector?     okou connector check --env-name <ENV_NAME>",
    ...(payload && !payload.capabilities.includes("billing:read")
      ? []
      : ["  Check credits?         okou credit"]),
    ...(payload && !payload.capabilities.includes("billing:write")
      ? []
      : ["  Buy credits?           okou credit 20000"]),
    ...commandExampleIfVisible(
      "upgrade",
      "  Upgrade plan?         okou upgrade pro",
      payload,
    ),
    "  Send a Slack message?  okou slack message send --help",
    ...commandExampleIfVisible(
      "feishu",
      "  Send Feishu?          okou feishu message send --help",
      payload,
    ),
    ...commandExampleIfVisible(
      "lark",
      "  Send Lark?            okou lark message send --help",
      payload,
    ),
    ...commandExampleIfVisible(
      "mail",
      "  Link Gmail draft?     okou mail link --help",
      payload,
    ),
    "  Send Teams?           okou teams message send --help",
    "  Upload Teams?         okou teams upload-file --help",
    "  Download Teams?       okou teams download-file --help",
    "  Upload GitHub?        okou github upload-file --help",
    "  Download GitHub?      okou github download-file --help",
    "  List Telegram bots?    okou telegram bot list",
    "  Send Telegram?         okou telegram message send --help",
    "  Upload Telegram?       okou telegram upload-file --help",
    "  Download Telegram?     okou telegram download-file --help",
    "  Send AgentPhone?       okou phone message --help",
    "  Upload AgentPhone?     okou phone upload-file --help",
    "  Download AgentPhone?   okou phone download-file --help",
    "  List models?          okou model ls",
    "  Model routing?        okou model-provider ls",
    "  Update yourself?       okou agent --help",
    "  Manage workflows?     okou workflow --help",
    ...commandExampleIfVisible(
      "chat",
      '  Rename this chat?     okou chat rename "New title"',
      payload,
    ),
    "  Introduce Okou?       okou intro",
    "  List generators?       okou generate --help",
    '  Generate image?        okou generate image --raw-prompt "..."',
    '  Generate website?      okou generate website --prompt "..."',
    '  Generate voice?        okou generate voice --prompt "..."',
    ...(canWriteHost
      ? ["  Host a static site?    okou host ./dist --site my-site --spa"]
      : []),
    ...(canReadHost
      ? ["  Clone hosted site?     okou host clone <public-slug>"]
      : []),
    ...commandExampleIfVisible(
      "artifact",
      "  Artifact visibility?   okou artifact --help",
      payload,
    ),
    ...commandExampleIfVisible(
      "maps",
      '  Get directions?       okou maps directions --origin "SFO" --destination "Mountain View" --json',
      payload,
    ),
    ...commandExampleIfVisible(
      "weather",
      "  Check weather?        okou weather current --lat 39.9042 --lng 116.4074 --json",
      payload,
    ),
    ...commandExampleIfVisible(
      "scrape",
      "  Scrape a web page?    okou scrape https://example.com --json",
      payload,
    ),
    ...commandExampleIfVisible(
      "web-search",
      '  Search the public web? okou web-search "latest news" --json',
      payload,
    ),
    ...commandExampleIfVisible(
      "social",
      "  Analyze social data?   okou social transcript https://youtu.be/dQw4w9WgXcQ --json",
      payload,
    ),
    ...commandExampleIfVisible(
      "image-recognition",
      '  Recognize an image?    okou image-recognition --file ./image.png --prompt "Describe it"',
      payload,
    ),
    ...commandExampleIfVisible(
      "finance",
      "  Get a market quote?   okou finance quote AAPL --json",
      payload,
    ),
    ...commandExampleIfVisible(
      "seo",
      '  Research SEO data?    okou seo serp "technical seo" --json',
      payload,
    ),
    ...commandExampleIfVisible(
      "people-search",
      '  Find a professional?   okou people-search "platform engineering leaders" --json',
      payload,
    ),
    ...commandExampleIfVisible(
      "banking",
      "  Read bank data?       okou banking accounts --json",
      payload,
    ),
    "  Check your identity?   okou whoami",
  ];

  return `\nExamples:\n${examples.join("\n")}`;
}

/**
 * Register commands with visibility based on OKOU_TOKEN capabilities.
 * Commands not granted by the token are registered as hidden via
 * Commander's public `addCommand(cmd, { hidden: true })` API.
 * Without OKOU_TOKEN, globally available commands stay visible while
 * run-only commands remain hidden.
 *
 * @param commands - override default commands (used in tests)
 */
export function registerCommands(prog: Command, commands?: Command[]): void {
  instrumentCommand(prog);
  const token = getOkouToken();
  const payload = token ? decodeSandboxTokenPayload(token) : undefined;

  for (const cmd of commands ?? buildDefaultCommands()) {
    addCommandWithVisibility(prog, cmd, payload);
  }
}

const program = new Command();

declare const __CLI_VERSION__: string;

program
  .name("okou")
  .description("Okou CLI — interact with Okou from inside the sandbox")
  .version(__CLI_VERSION__)
  .addHelpText("after", () => {
    return buildHelpText();
  });

export { program };

if (
  process.argv[1]?.endsWith("okou.js") ||
  process.argv[1]?.endsWith("okou.ts") ||
  process.argv[1]?.endsWith("okou")
) {
  await configureGlobalProxyFromEnv();
  await registerRequestedCommand(program);
  program.parse();
}
