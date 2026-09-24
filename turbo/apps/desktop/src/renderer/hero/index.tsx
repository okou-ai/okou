import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Building,
  Code,
  Ellipsis,
  FolderPlus,
  KeyRound,
  LogOut,
  Play,
  Square,
  Plug,
  Trash,
} from "lucide-react";
import { useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { DesktopAuthState } from "../../desktop-bridge";
import {
  hasRequiredComputerUsePermissions,
  type DesktopComputerUseState,
} from "../../computer-use-types";
import {
  addFilesystemPluginAllowedDirectory$,
  desktopLoginMethodData$,
  importMcpPluginServers$,
  openDesktopOrgSelection$,
  removeFilesystemPluginAllowedDirectory$,
  removeMcpPluginServer$,
  setFilesystemPluginEnabled$,
  setDesktopLoginMethod$,
  setMcpPluginServerEnabled$,
  signOutDesktop$,
  startComputerUse$,
  stopComputerUse$,
} from "../computer-use-state";
import { CommandLogPanel, RuntimePanel } from "../command-log";
import {
  CheckboxRow,
  IconButton,
  Panel,
  STATUS_LABELS,
  DesktopBrandMark,
  type HostStatus,
} from "../components";
import { PermissionAutoRefresh } from "../setup-wizard";

type FilesystemPluginState = NonNullable<
  DesktopComputerUseState["plugins"]
>["filesystem"];

const FILESYSTEM_PLUGIN_STATUS_LABELS = {
  disabled: "Disabled",
  starting: "Starting",
  running: "Ready",
  restarting: "Restarting",
  error: "Error",
} as const satisfies Record<FilesystemPluginState["status"], string>;

const MCP_SERVER_STATUS_LABELS = FILESYSTEM_PLUGIN_STATUS_LABELS;

const MCP_SERVERS_SAMPLE_CONFIG = `{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "mcp-apple-notes"]
    },
    "figma": {
      "url": "http://127.0.0.1:3845/mcp"
    }
  }
}`;

const ARRIVAL_ANIMATION_MS = 1_100;

function isRunningStatus(status: HostStatus): boolean {
  return (
    status === "online" || status === "connecting" || status === "recovering"
  );
}

function Radar() {
  return (
    <div className="radar" aria-hidden="true">
      <span className="radar-aura" />
      <span className="radar-wave radar-wave-3" />
      <span className="radar-wave radar-wave-2" />
      <span className="radar-wave radar-wave-1" />
      <DesktopBrandMark className="desktop-brand-mark-hero" size={104} />
    </div>
  );
}

interface FooterMenuItem {
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly tone?: "default" | "danger";
}

function FooterMenu({ items }: { readonly items: readonly FooterMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="footer-menu" ref={containerRef}>
      <button
        type="button"
        className="footer-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account actions"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <Ellipsis size={17} />
      </button>
      {open && (
        <div className="footer-menu-popover" role="menu">
          {items.map((item) => {
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`footer-menu-item${
                  item.tone === "danger" ? " is-danger" : ""
                }`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HeroFooter({
  authState,
  menuItems,
  permissionGranted,
}: {
  readonly authState: DesktopAuthState | null;
  readonly menuItems: readonly FooterMenuItem[];
  readonly permissionGranted?: boolean;
}) {
  const signedIn = authState?.status === "signed_in" ? authState : null;
  const userLabel =
    signedIn?.user.email ??
    signedIn?.user.phoneNumber ??
    signedIn?.user.userId ??
    "Signed in";
  const organization = signedIn?.organization?.name ?? null;
  const identity = organization ? `${userLabel} · ${organization}` : userLabel;
  return (
    <div className="hero-footer">
      <span className="hero-footer-id">
        {permissionGranted !== undefined && (
          <span
            className={`status-dot${
              permissionGranted ? " is-online" : " is-pending"
            }`}
            title={
              permissionGranted
                ? "Accessibility and screen recording granted"
                : "Accessibility and screen recording needed"
            }
          />
        )}
        <span>{identity}</span>
      </span>
      <FooterMenu items={menuItems} />
    </div>
  );
}

function OnlineHero({
  authState,
  state,
}: {
  readonly authState: DesktopAuthState | null;
  readonly state: DesktopComputerUseState;
}) {
  const [stopLoadable, stop] = useLoadableSet(stopComputerUse$);
  const deviceName = state.deviceName?.trim() ? state.deviceName.trim() : null;
  const statusLabel = STATUS_LABELS[state.host.status];
  const stopDisabled =
    (state.host.status !== "online" && state.host.status !== "recovering") ||
    stopLoadable.state === "loading";
  return (
    <section className="hero hero-online">
      <div className="hero-stage">
        <Radar />
        <p className="hero-name">{deviceName ?? statusLabel}</p>
        {deviceName && (
          <p className="hero-substatus">
            <span
              className={`status-dot${
                state.host.status === "online" ? " is-online" : " is-pending"
              }`}
            />
            {statusLabel}
          </p>
        )}
      </div>
      <HeroFooter
        authState={authState}
        menuItems={[
          {
            icon: <Square size={15} />,
            label: "Stop",
            tone: "danger",
            disabled: stopDisabled,
            onClick: () => {
              void stop();
            },
          },
        ]}
      />
    </section>
  );
}

function OfflineHero({
  authState,
  state,
}: {
  readonly authState: DesktopAuthState | null;
  readonly state: DesktopComputerUseState;
}) {
  const [startLoadable, start] = useLoadableSet(startComputerUse$);
  const [orgSelectionLoadable, selectOrg] = useLoadableSet(
    openDesktopOrgSelection$,
  );
  const [signOutLoadable, signOut] = useLoadableSet(signOutDesktop$);
  const startDisabled =
    state.host.status === "disabled" || startLoadable.state === "loading";
  const permissionGranted = hasRequiredComputerUsePermissions(
    state.permissions,
  );
  return (
    <section className="hero hero-offline">
      <div className="hero-stage">
        <DesktopBrandMark className="desktop-brand-mark-offline" size={108} />
        <p className="hero-name hero-name-muted">Offline</p>
        <button
          type="button"
          className="go-online-button"
          onClick={() => {
            void start();
          }}
          disabled={startDisabled}
        >
          <Play size={16} />
          <span>Go online</span>
        </button>
      </div>
      <HeroFooter
        authState={authState}
        permissionGranted={permissionGranted}
        menuItems={[
          {
            icon: <Building size={15} />,
            label: "Switch workspace",
            disabled: orgSelectionLoadable.state === "loading",
            onClick: () => {
              void selectOrg();
            },
          },
          {
            icon: <LogOut size={15} />,
            label: "Sign out",
            tone: "danger",
            disabled: signOutLoadable.state === "loading",
            onClick: () => {
              void signOut();
            },
          },
        ]}
      />
    </section>
  );
}

function ArrivalOverlay() {
  return (
    <div className="arrival-overlay" aria-hidden="true">
      <span className="arrival-flash" />
      <span className="arrival-label">Connected</span>
    </div>
  );
}

function FilesystemPluginPanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const plugin = state.plugins?.filesystem;
  const [enabledLoadable, setEnabled] = useLoadableSet(
    setFilesystemPluginEnabled$,
  );
  const [addDirectoryLoadable, addDirectory] = useLoadableSet(
    addFilesystemPluginAllowedDirectory$,
  );
  const [removeDirectoryLoadable, removeDirectory] = useLoadableSet(
    removeFilesystemPluginAllowedDirectory$,
  );

  if (!plugin?.featureEnabled) {
    return null;
  }

  const busy =
    enabledLoadable.state === "loading" ||
    addDirectoryLoadable.state === "loading" ||
    removeDirectoryLoadable.state === "loading";
  const statusLabel = FILESYSTEM_PLUGIN_STATUS_LABELS[plugin.status];
  const directoryCount = plugin.allowedDirectories.length;

  return (
    <Panel title="Filesystem plugin" icon={<FolderPlus size={18} />}>
      <div className="runtime-grid">
        <div>
          <span>Status</span>
          <strong>{statusLabel}</strong>
        </div>
        <div>
          <span>Directories</span>
          <strong>{directoryCount}</strong>
        </div>
        <div>
          <span>Tools</span>
          <strong>{plugin.capabilities.length}</strong>
        </div>
        <div>
          <span>Version</span>
          <strong>{plugin.version}</strong>
        </div>
      </div>
      <CheckboxRow
        title="Enable filesystem"
        subtitle="Allow authorized Computer Use sessions to use selected folders."
        meta={statusLabel}
        checked={plugin.enabled}
        disabled={busy}
        onChange={(enabled) => {
          void setEnabled(enabled);
        }}
      />
      <div className="filesystem-directory-list">
        {plugin.allowedDirectories.length === 0 ? (
          <div className="compact-empty">No directories added.</div>
        ) : (
          plugin.allowedDirectories.map((directory) => {
            return (
              <div className="filesystem-directory-row" key={directory}>
                <span>{directory}</span>
                <button
                  type="button"
                  className="icon-only-button"
                  aria-label={`Remove ${directory}`}
                  title="Remove directory"
                  disabled={busy}
                  onClick={() => {
                    void removeDirectory(directory);
                  }}
                >
                  <Trash size={15} />
                </button>
              </div>
            );
          })
        )}
      </div>
      {plugin.lastError && (
        <div className="inline-alert inline-alert-error">
          <AlertCircle size={16} />
          <span>{plugin.lastError}</span>
        </div>
      )}
      <div className="panel-actions">
        <IconButton
          icon={<FolderPlus size={15} />}
          onClick={() => {
            void addDirectory();
          }}
          disabled={busy}
        >
          Add directory
        </IconButton>
      </div>
    </Panel>
  );
}

function LoginMethodPanel() {
  const methodLoadable = useLastLoadable(desktopLoginMethodData$);
  const [switchLoadable, switchMethod] = useLoadableSet(setDesktopLoginMethod$);
  const method =
    methodLoadable.state === "hasData" ? methodLoadable.data : null;
  const error =
    switchLoadable.state === "hasError" ? switchLoadable.error : null;

  return (
    <Panel title="Login method" icon={<KeyRound size={18} />}>
      <CheckboxRow
        title="Native Clerk sign-in"
        subtitle="Switching signs you out, stops Computer Use, and restarts Desktop. Sign in again after the restart."
        meta={method?.method === "native" ? "Native" : "Browser"}
        checked={method?.method === "native"}
        disabled={
          method === null ||
          (!method.nativeAvailable && method.method !== "native") ||
          switchLoadable.state === "loading"
        }
        onChange={(enabled) => {
          void switchMethod(enabled ? "native" : "browser");
        }}
      />
      {error !== null && (
        <div className="inline-alert inline-alert-error" role="alert">
          <AlertCircle size={16} />
          <span>{error instanceof Error ? error.message : String(error)}</span>
        </div>
      )}
      {method && !method.nativeAvailable && (
        <p className="compact-empty">
          Native Clerk requires a packaged macOS build with a Clerk publishable
          key.
        </p>
      )}
    </Panel>
  );
}

function McpPluginsPanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const plugin = state.plugins?.mcp;
  const [configJson, setConfigJson] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importLoadable, importServers] = useLoadableSet(
    importMcpPluginServers$,
  );
  const [setEnabledLoadable, setServerEnabled] = useLoadableSet(
    setMcpPluginServerEnabled$,
  );
  const [removeLoadable, removeServer] = useLoadableSet(removeMcpPluginServer$);

  if (!plugin?.featureEnabled) {
    return null;
  }

  const busy =
    importLoadable.state === "loading" ||
    setEnabledLoadable.state === "loading" ||
    removeLoadable.state === "loading";

  const submitImport = async () => {
    setImportError(null);
    try {
      await importServers(configJson);
      setConfigJson("");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Panel title="MCP servers" icon={<Plug size={18} />}>
      <div className="filesystem-directory-list">
        {plugin.servers.length === 0 ? (
          <div className="compact-empty">No MCP servers configured.</div>
        ) : (
          plugin.servers.map((server) => {
            return (
              <div className="mcp-server-entry" key={server.name}>
                <div className="mcp-server-row">
                  <label className="mcp-server-toggle">
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      disabled={busy}
                      onChange={(event) => {
                        void setServerEnabled({
                          server: server.name,
                          enabled: event.currentTarget.checked,
                        });
                      }}
                    />
                    <span className="checkbox-row-copy">
                      <span className="row-title">{server.name}</span>
                      <span className="row-meta">
                        {server.transport === "http"
                          ? "Streamable HTTP"
                          : "stdio"}
                        {server.status === "running"
                          ? ` · ${server.tools.length} tools`
                          : ""}
                      </span>
                    </span>
                    <span className="checkbox-row-meta">
                      {MCP_SERVER_STATUS_LABELS[server.status]}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="icon-only-button"
                    aria-label={`Remove ${server.name}`}
                    title="Remove server"
                    disabled={busy}
                    onClick={() => {
                      void removeServer(server.name);
                    }}
                  >
                    <Trash size={15} />
                  </button>
                </div>
                {server.lastError && (
                  <div className="inline-alert inline-alert-error">
                    <AlertCircle size={16} />
                    <span>{server.lastError}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <textarea
        className="mcp-config-input"
        placeholder={MCP_SERVERS_SAMPLE_CONFIG}
        value={configJson}
        rows={8}
        spellCheck={false}
        disabled={busy}
        onChange={(event) => {
          setConfigJson(event.target.value);
        }}
      />
      {importError && (
        <div className="inline-alert inline-alert-error">
          <AlertCircle size={16} />
          <span>{importError}</span>
        </div>
      )}
      <div className="panel-actions">
        <IconButton
          icon={<Code size={15} />}
          onClick={() => {
            setImportError(null);
            setConfigJson(MCP_SERVERS_SAMPLE_CONFIG);
          }}
          disabled={busy}
        >
          Use sample
        </IconButton>
        <IconButton
          icon={<Plug size={15} />}
          onClick={() => {
            void submitImport();
          }}
          disabled={busy || !configJson.trim()}
        >
          Import servers
        </IconButton>
      </div>
    </Panel>
  );
}

export function ReadyExperience({
  authState,
  developerToolsEnabled,
  state,
}: {
  readonly authState: DesktopAuthState | null;
  readonly developerToolsEnabled: boolean;
  readonly state: DesktopComputerUseState;
}) {
  const running = isRunningStatus(state.host.status);
  const previousStatusRef = useRef<HostStatus>(state.host.status);
  const [arrivalVisible, setArrivalVisible] = useState(false);

  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = state.host.status;
    if (state.host.status === "online" && !isRunningStatus(previous)) {
      setArrivalVisible(true);
      const id = window.setTimeout(() => {
        setArrivalVisible(false);
      }, ARRIVAL_ANIMATION_MS);
      return () => {
        window.clearTimeout(id);
      };
    }
    return undefined;
  }, [state.host.status]);

  return (
    <>
      {running ? (
        <OnlineHero authState={authState} state={state} />
      ) : (
        <OfflineHero authState={authState} state={state} />
      )}
      {!running && <PermissionAutoRefresh />}
      {developerToolsEnabled && (
        <>
          <LoginMethodPanel />
          <FilesystemPluginPanel state={state} />
          <McpPluginsPanel state={state} />
          <RuntimePanel state={state} />
          <CommandLogPanel state={state} />
        </>
      )}
      {arrivalVisible && <ArrivalOverlay />}
    </>
  );
}
