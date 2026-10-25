import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AccountSnapshot, AppStateSnapshot, AuthorizedKey, CommandResult, ComposeProject, CredentialStatus, CronJob, DiskExplorerSnapshot, DockerSnapshot, FirewallSnapshot, LargestDirectory, PackagePage, PortInfo, ProcessInfo, RemoteFile, SavedCommand, SecuritySnapshot, ServerCapabilities, ServerConnection, ServerProfile, ServiceDetails, ServiceInfo, TerminalTab, TransferProgress, TunnelConfig, TunnelStatus } from "../types";
import { DEFAULT_CONFIG, DEFAULT_THEME, type TerminalConfig, type XtermTheme } from "./config";
import { LINUX_DEFAULTS, MACOS_DEFAULTS, parseKeybindings, type Keybinding } from "./keybindings";
import { TerminalSurface } from "./terminal-surface";
import type { ActiveOperation, AdministrationTab, ContainerPlatformTab, DashboardState, DiskTab, DockerSection, HostKeyMismatch, HostKeyUnknown, LogTarget, LogViewerState, MasterPasswordPromptMode, ModalKind, TerminalGroup, View, WorkspaceTab } from "./types";

export const root = document.querySelector<HTMLDivElement>("#app")!;

/** This window is the quick terminal (src-tauri/src/quick.rs): local shells only, no app chrome. */
export const quickMode = new URLSearchParams(window.location.search).has("quick");

/** The always-open workspace for shells on this machine. Must match `LOCAL_SERVER_ID` in local_pty.rs. */
export const LOCAL_WORKSPACE_ID = "local";
export const LOCAL_SERVER_ID = "local";
/**
 * WebGL is the fast renderer, but in WebKitGTK resized WebGL terminals were not repainted
 * (seen with software GL), so Linux uses the DOM renderer unless WebGL is chosen explicitly.
 */
export const useWebglRenderer = (): boolean => state.terminalRenderer === "webgl" || (state.terminalRenderer === "auto" && platform === "macos");
export const isLocalWorkspace = (): boolean => state.activeWorkspaceTabId === LOCAL_WORKSPACE_ID;

/** A server's terminals docked beside its other views (Files, Logs, …). */
export interface TerminalDock { open: boolean; position: "right" | "bottom"; ratio: number }
export const terminalDocks = new Map<string, TerminalDock>();
export const activeDock = (): TerminalDock | undefined =>
  state.activeWorkspaceTabId && !isLocalWorkspace() ? terminalDocks.get(state.activeWorkspaceTabId) : undefined;
/** Whether the current page shows the terminal dock (a server view other than Terminal, dock open). */
export const dockShown = (): boolean => Boolean(activeDock()?.open) && state.activeView !== "terminal" && Boolean(state.activeServerId);
export const appWindow = getCurrentWindow();
export const appWebview = getCurrentWebview();
export const platform = /mac/i.test(navigator.platform || navigator.userAgent) ? "macos" : /win/i.test(navigator.platform || navigator.userAgent) ? "windows" : "linux";

export const INTERFACE_SCALE_LEVELS = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2] as const;
export const DEFAULT_INTERFACE_SCALE = 1;
export interface ResolvedProfile {
  config: TerminalConfig;
  theme: XtermTheme;
}

export interface LoadedTerminalConfig extends ResolvedProfile {
  path: string;
  /** Each profile is the main config with the profile file layered on top. */
  profiles: Map<string, ResolvedProfile>;
  ignored: string[];
  errors: string[];
}

export type TerminalRenderer = "auto" | "webgl" | "dom";
const storedRenderer = localStorage.getItem("hbox-term-renderer");

const storedInterfaceScale = Number(localStorage.getItem("hbox-term-interface-scale"));

/** Mutable application state shared by every module. */
export class AppState {
  interfaceScale = INTERFACE_SCALE_LEVELS.includes(storedInterfaceScale as typeof INTERFACE_SCALE_LEVELS[number])
    ? storedInterfaceScale
    : DEFAULT_INTERFACE_SCALE;
  snapshot: AppStateSnapshot = { version: 1, servers: [], sshKeys: [], sshConfigEntries: [] };
  activeServerId: string | null = null;
  activeWorkspaceTabId: string | null = null;
  openServerTabs: WorkspaceTab[] = [];
  sidebarCopyPlacement: { sourceId: string; copyId: string } | null = null;
  activeView: View = "dashboard";
  serverQuery = "";
  darkMode = localStorage.getItem("hbox-term-theme") !== "light";
  loading = true;
  errorMessage = "";
  modal: ModalKind = null;
  editingServer: ServerProfile | null = null;
  renamingWorkspaceTabId: string | null = null;
  credentialStatus: CredentialStatus = { configured: false, unlocked: false };
  masterPasswordPrompt: { mode: MasterPasswordPromptMode; error: string } | null = null;
  masterPasswordWaiter: Promise<string | null> | null = null;
  finishMasterPasswordWaiter: ((value: string | null) => void) | null = null;
  textInputPrompt: { title: string; label: string; defaultValue: string; placeholder?: string; allowEmpty?: boolean; multiline?: boolean; choices?: string[] } | null = null;
  finishTextInputWaiter: ((value: string | null) => void) | null = null;
  appDialogPrompt: { title: string; message: string; kind: "info" | "warning"; confirmLabel: string; cancelLabel?: string } | null = null;
  finishAppDialogWaiter: ((value: boolean) => void) | null = null;
  appToast: { message: string; kind: "success" | "info" } | null = null;
  appToastTimer: number | undefined;
  hostKeyPrompt: { mismatch?: HostKeyMismatch; unknown?: HostKeyUnknown; error: string } | null = null;
  hostKeyWaiter: Promise<boolean> | null = null;
  finishHostKeyWaiter: ((trust: boolean) => void) | null = null;
  credentialSettingsError = "";
  credentialSettingsNotice = "";
  connection: ServerConnection | null = null;
  dashboard: DashboardState | null = null;
  processes: ProcessInfo[] = [];
  services: ServiceInfo[] = [];
  serviceDetails: ServiceDetails | null = null;
  diskSnapshot: DiskExplorerSnapshot | null = null;
  diskTab: DiskTab = "mounts";
  diskVarLog: LargestDirectory[] | null = null;
  diskVarLogLoading = false;
  docker: DockerSnapshot | null = null;
  containerPlatformTab: ContainerPlatformTab = "runtime";
  dockerTab: DockerSection = "containers";
  dockerLoaded: Record<DockerSection, boolean> = { containers: false, images: false, volumes: false, networks: false };
  dockerHasMore: Record<DockerSection, boolean> = { containers: false, images: false, volumes: false, networks: false };
  composeScaleProject: ComposeProject | null = null;
  containerLogViewer: LogViewerState | null = null;
  shouldScrollToContainerLogs = false;
  inspectText = "";
  logsViewer: LogViewerState = createLogViewer({ source: "system", label: "System logs" }, 100);
  discoveredLogFiles: string[] = [];
  ports: PortInfo[] = [];
  cronJobs: CronJob[] = [];
  editingCron: CronJob | null = null;
  packagePage: PackagePage | null = null;
  packageQuery = "";
  packageUpgradesOnly = false;
  packageDetailsText = "";
  accounts: AccountSnapshot | null = null;
  accountTab: "users" | "groups" = "users";
  administrationTab: AdministrationTab = "firewall";
  composeProjects: ComposeProject[] = [];
  composeProjectsServerId: string | null = null;
  firewallSnapshot: FirewallSnapshot | null = null;
  authorizedKeys: AuthorizedKey[] = [];
  securitySnapshot: SecuritySnapshot | null = null;
  savedCommands: SavedCommand[] = [];
  editingCommand: SavedCommand | null = null;
  tunnels: TunnelConfig[] = [];
  tunnelStatuses: TunnelStatus[] = [];
  editingTunnel: TunnelConfig | null = null;
  commandResults: CommandResult[] = [];
  shouldScrollToCommandResults = false;
  passwordUser = "";
  processesHasMore = false;
  servicesHasMore = false;
  filesHaveMore = false;
  portsHaveMore = false;
  remotePath = "/";
  remoteFiles: RemoteFile[] = [];
  showHidden = false;
  remoteFileSearch = "";
  editorPath = "";
  editorContent = "";
  editorDirty = false;
  transfer: TransferProgress | null = null;
  transferDismissTimer: number | undefined;
  refreshTimer: number | undefined;
  terminalTabs: TerminalTab[] = [];
  activeTerminalTabId: string | null = null;
  terminalGroups: TerminalGroup[] = [];
  terminalConfig: LoadedTerminalConfig = { path: "", config: DEFAULT_CONFIG, theme: DEFAULT_THEME, profiles: new Map(), ignored: [], errors: [] };
  keybindings: Keybinding[] = parseKeybindings(platform === "macos" ? MACOS_DEFAULTS : LINUX_DEFAULTS);
  terminalRenderer: TerminalRenderer = storedRenderer === "webgl" || storedRenderer === "dom" ? storedRenderer : "auto";
  terminalUnlisteners: UnlistenFn[] = [];
  navigationVersion = 0;
  viewTransition: { serverId: string; view: View; version: number } | null = null;
  renderedLocation = "";
  activeOperation: ActiveOperation | null = null;
}

export const state = new AppState();

export const serverTabViews = new Map<string, View>();
export const connectedServerIds = new Set<string>();
export const dashboardSnapshots = new Map<string, DashboardState>();
export const activeTerminalTabByWorkspace = new Map<string, string>();
export const terminalSurfaces = new Map<string, TerminalSurface>();
export const terminalInputChains = new Map<string, Promise<void>>();
export const viewScrollPositions = new Map<string, number>();
export const sidebarScrollPositions = { servers: 0, navigation: 0 };

export const PROCESS_PAGE_SIZE = 100;
export const SERVICE_PAGE_SIZE = 100;
export const FILE_PAGE_SIZE = 100;
export const PORT_PAGE_SIZE = 150;
export const DOCKER_PAGE_SIZE = 60;
export const DASHBOARD_OVERVIEW_TIMEOUT_MS = 20_000;
export const LOG_LINE_OPTIONS = [100, 250, 300, 500, 1000] as const;

export const activeServer = (): ServerProfile | undefined => state.snapshot.servers.find((server) => server.id === state.activeServerId);
export const activeWorkspaceTab = (): WorkspaceTab | undefined => state.openServerTabs.find((tab) => tab.id === state.activeWorkspaceTabId);
export const activeCapabilities = (): ServerCapabilities | null => state.dashboard?.profile?.capabilities ?? null;
export const hasInteractiveSession = (serverId = state.activeServerId): boolean => Boolean(serverId) && state.terminalTabs.some((tab) => tab.serverId === serverId && Boolean(tab.sessionId) && !tab.closed);
export const activeTerminalTabs = (): TerminalTab[] => state.terminalTabs.filter((tab) => tab.workspaceTabId === state.activeWorkspaceTabId);
export const activeTerminalGroups = (): TerminalGroup[] => state.terminalGroups.filter((group) => group.workspaceTabId === state.activeWorkspaceTabId);
export const terminalGroupOf = (terminalId: string | null): TerminalGroup | undefined => {
  const groupId = state.terminalTabs.find((tab) => tab.id === terminalId)?.groupId;
  return state.terminalGroups.find((group) => group.id === groupId);
};
export const activeTerminalGroup = (): TerminalGroup | undefined => terminalGroupOf(state.activeTerminalTabId);
export const activeServerIsConnected = (): boolean => Boolean(state.activeServerId && (connectedServerIds.has(state.activeServerId) || hasInteractiveSession(state.activeServerId)));

export function createLogViewer(target: LogTarget, lines: number): LogViewerState {
  return { target, text: "", lines, since: "", query: "", severity: "all", following: false, status: "idle" };
}
