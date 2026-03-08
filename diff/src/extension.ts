import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

type DiffOp =
  | { kind: "equal"; line: string }
  | { kind: "add"; line: string }
  | { kind: "remove"; line: string };

type TriggerMode = "toggleFile" | "httpDirty";
type DirtyCommand = "idle" | "diff" | "busy" | "invalid";

interface ExtensionSettings {
  triggerMode: TriggerMode;
  toggleFilePath: string;
  pollingIntervalMs: number;
  serverBaseUrl: string;
  dirtyServerBaseUrl: string;
  diffServerBaseUrl: string;
  dirtyEndpointPath: string;
  diffUploadEndpointPath: string;
  httpTimeoutMs: number;
}

interface EditorDiffSnapshot {
  document: vscode.TextDocument;
  filePath: string;
  diffText: string;
  hasChanges: boolean;
}

interface DiffUploadPayload {
  timestamp: string;
  filePath: string;
  hasChanges: boolean;
  diff: string;
}

let pollingTimer: NodeJS.Timeout | undefined;
let isProcessing = false;
let outputChannel: vscode.OutputChannel;
const logWindowMs = 30000;
const lastLogByKey = new Map<string, number>();

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Toggle Diff Watcher");
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand("toggleDiffWatcher.start", () => {
      startPolling();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("toggleDiffWatcher.stop", () => {
      stopPolling();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("toggleDiffWatcher")) {
        return;
      }

      log("Configuration changed: toggleDiffWatcher.*");
      if (pollingTimer) {
        stopPolling();
        startPolling();
      }
    })
  );

  startPolling();
}

export function deactivate(): void {
  stopPolling();
  outputChannel.dispose();
}

function startPolling(): void {
  if (pollingTimer) {
    log("Start requested but poller is already running.");
    return;
  }

  const settings = getSettings();
  const intervalMs = Math.max(10, Math.floor(settings.pollingIntervalMs));

  pollingTimer = setInterval(() => {
    void pollOnce();
  }, intervalMs);

  log(
    `Polling started with interval ${intervalMs} ms. Mode: ${settings.triggerMode}.`
  );
}

function stopPolling(): void {
  if (!pollingTimer) {
    log("Stop requested but poller is already stopped.");
    return;
  }

  clearInterval(pollingTimer);
  pollingTimer = undefined;
  log("Polling stopped.");
}

async function pollOnce(): Promise<void> {
  if (isProcessing) {
    return;
  }

  const settings = getSettings();
  isProcessing = true;
  try {
    if (settings.triggerMode === "httpDirty") {
      await pollHttpMode(settings);
      return;
    }

    await pollToggleFileMode(settings);
  } finally {
    isProcessing = false;
  }
}

async function pollToggleFileMode(settings: ExtensionSettings): Promise<void> {
  const togglePath = resolveTogglePath(settings.toggleFilePath);
  if (!togglePath) {
    logThrottled(
      "missing-toggle-path",
      'Set "toggleDiffWatcher.toggleFilePath" to enable toggleFile mode.'
    );
    return;
  }

  try {
    const toggleValue = fs.readFileSync(togglePath, "utf8").trim();
    if (toggleValue !== "1") {
      return;
    }

    log(`Toggle set to 1 at ${togglePath}. Processing active editor.`);
    await handleToggleTrigger(togglePath);
  } catch (error) {
    logThrottled(
      `toggle-read-failed:${togglePath}`,
      `Unable to read toggle file: ${togglePath}. ${toErrorMessage(error)}`
    );
  }
}

async function handleToggleTrigger(togglePath: string): Promise<void> {
  try {
    const snapshot = collectActiveEditorDiff();
    if (!snapshot) {
      return;
    }

    const diffFilePath = buildDiffOutputPath(snapshot.filePath);
    fs.writeFileSync(diffFilePath, snapshot.diffText, "utf8");
    log(`Diff file created: ${diffFilePath}`);

    const didSave = await snapshot.document.save();
    log(
      didSave
        ? `Document saved: ${snapshot.filePath}`
        : `Document save returned false: ${snapshot.filePath}`
    );
  } catch (error) {
    log(`Error while processing toggle trigger: ${toErrorMessage(error)}`);
  } finally {
    try {
      fs.writeFileSync(togglePath, "0", "utf8");
      log(`Toggle reset to 0: ${togglePath}`);
    } catch (error) {
      log(`Failed to reset toggle file: ${toErrorMessage(error)}`);
    }
  }
}

async function pollHttpMode(settings: ExtensionSettings): Promise<void> {
  const dirtyUrl = buildHttpUrl(
    resolveBaseUrl(settings.dirtyServerBaseUrl, settings.serverBaseUrl),
    settings.dirtyEndpointPath,
    "toggleDiffWatcher.dirtyServerBaseUrl/toggleDiffWatcher.serverBaseUrl"
  );
  if (!dirtyUrl) {
    return;
  }

  try {
    const response = await fetchWithTimeout(
      dirtyUrl,
      {
        method: "GET"
      },
      settings.httpTimeoutMs
    );
    const responseText = (await safeReadText(response)).trim();
    log(
      `GET ${dirtyUrl} -> ${response.status} ${response.statusText}; body=${responseText || "<empty>"}`
    );

    if (isBusyStatus(response.status) || isBusyText(responseText)) {
      logThrottled(
        `dirty-busy:${dirtyUrl}`,
        `Server busy on ${dirtyUrl}. Waiting for next poll.`
      );
      return;
    }

    if (!response.ok) {
      logThrottled(
        `dirty-http-failure:${dirtyUrl}`,
        `GET ${dirtyUrl} failed (${response.status} ${response.statusText}).`
      );
      return;
    }

    const command = parseDirtyCommand(responseText);

    if (command === "busy") {
      logThrottled(
        `dirty-busy-command:${dirtyUrl}`,
        `Server reported busy command on ${dirtyUrl}. Waiting for next poll.`
      );
      return;
    }

    if (command === "idle") {
      return;
    }

    if (command !== "diff") {
      logThrottled(
        `unexpected-dirty-response:${dirtyUrl}`,
        `Unexpected /dirty response "${responseText.trim()}". Expected JSON command idle/diff (legacy YES/NO also accepted).`
      );
      return;
    }

    log(`Received diff command from ${dirtyUrl}. Collecting diff and uploading.`);

    const snapshot = collectActiveEditorDiff();
    if (!snapshot) {
      return;
    }

    await uploadDiff(settings, snapshot);
  } catch (error) {
    logThrottled(
      `dirty-http-failure:${dirtyUrl}`,
      `HTTP polling failed for ${dirtyUrl}. ${toErrorMessage(error)}`
    );
  }
}

async function uploadDiff(
  settings: ExtensionSettings,
  snapshot: EditorDiffSnapshot
): Promise<void> {
  const uploadUrl = buildHttpUrl(
    resolveBaseUrl(settings.diffServerBaseUrl, settings.serverBaseUrl),
    settings.diffUploadEndpointPath,
    "toggleDiffWatcher.diffServerBaseUrl/toggleDiffWatcher.serverBaseUrl"
  );
  if (!uploadUrl) {
    return;
  }

  const payload: DiffUploadPayload = {
    timestamp: new Date().toISOString(),
    filePath: snapshot.filePath,
    hasChanges: snapshot.hasChanges,
    diff: snapshot.diffText
  };
  const requestUrl = buildDiffGetUrl(uploadUrl, payload);

  const response = await fetchWithTimeout(
    requestUrl,
    {
      method: "GET"
    },
    settings.httpTimeoutMs
  );
  const body = (await safeReadText(response)).trim();

  if (isBusyStatus(response.status) || isBusyText(body)) {
    logThrottled(
      `diff-upload-busy:${uploadUrl}`,
      `Server busy on ${uploadUrl}. Waiting for next poll.`
    );
    return;
  }

  if (!response.ok) {
    const bodySuffix = body ? ` Response body: ${body}` : "";
    log(
      `Diff upload failed (${response.status} ${response.statusText}) to ${uploadUrl}.${bodySuffix}`
    );
    return;
  }

  log(
    `Diff uploaded successfully to ${uploadUrl}. hasChanges=${String(snapshot.hasChanges)}`
  );
}

function collectActiveEditorDiff(): EditorDiffSnapshot | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    log("No active text editor. Trigger ignored.");
    return undefined;
  }

  const document = editor.document;
  if (document.isUntitled) {
    log("Active editor is untitled. Trigger ignored.");
    return undefined;
  }

  try {
    const currentContent = document.getText();
    const savedContent = fs.readFileSync(document.uri.fsPath, "utf8");

    return {
      document,
      filePath: document.uri.fsPath,
      hasChanges: savedContent !== currentContent,
      diffText: buildHumanReadableLineDiff(
        savedContent,
        currentContent,
        document.uri.fsPath
      )
    };
  } catch (error) {
    log(
      `Failed to build diff for active document ${document.uri.fsPath}. ${toErrorMessage(error)}`
    );
    return undefined;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable in this VS Code runtime.");
  }

  const timeout = Math.max(100, Math.floor(timeoutMs));
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function isBusyStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 504;
}

function isBusyText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.toUpperCase() === "BUSY") {
    return true;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      status?: unknown;
      command?: unknown;
      state?: unknown;
    };

    return [parsed.status, parsed.command, parsed.state].some((value) => {
      return typeof value === "string" && value.toLowerCase() === "busy";
    });
  } catch {
    return false;
  }
}

function parseDirtyCommand(responseText: string): DirtyCommand {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return "idle";
  }

  const upper = trimmed.toUpperCase();
  if (upper === "NO") {
    return "idle";
  }
  if (upper === "YES") {
    return "diff";
  }
  if (upper === "BUSY") {
    return "busy";
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      command?: unknown;
      status?: unknown;
    };
    const commandValue =
      typeof parsed.command === "string"
        ? parsed.command.toLowerCase()
        : typeof parsed.status === "string"
          ? parsed.status.toLowerCase()
          : "";

    if (commandValue === "idle") {
      return "idle";
    }
    if (commandValue === "diff") {
      return "diff";
    }
    if (commandValue === "busy") {
      return "busy";
    }

    return "invalid";
  } catch {
    return "invalid";
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function buildHttpUrl(
  baseUrl: string,
  endpointPath: string,
  settingKey: string
): string | undefined {
  const trimmedBase = baseUrl.trim();
  const trimmedPath = endpointPath.trim();

  if (!trimmedBase) {
    logThrottled(
      `missing-server-base-url:${settingKey}`,
      `Set "${settingKey}" for httpDirty mode.`
    );
    return undefined;
  }

  const normalizedPath = trimmedPath.startsWith("/")
    ? trimmedPath
    : `/${trimmedPath}`;

  try {
    return new URL(normalizedPath, ensureTrailingSlash(trimmedBase)).toString();
  } catch (error) {
    logThrottled(
      `invalid-http-url:${trimmedBase}:${normalizedPath}`,
      `Invalid HTTP URL configuration. base="${trimmedBase}", path="${normalizedPath}". ${toErrorMessage(
        error
      )}`
    );
    return undefined;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function resolveBaseUrl(overrideValue: string, fallbackValue: string): string {
  return overrideValue.trim() || fallbackValue.trim();
}

function buildDiffGetUrl(baseUrl: string, payload: DiffUploadPayload): string {
  const urlObject = new URL(baseUrl);
  urlObject.searchParams.set("timestamp", payload.timestamp);
  urlObject.searchParams.set("filePath", payload.filePath);
  urlObject.searchParams.set("hasChanges", payload.hasChanges ? "1" : "0");
  urlObject.searchParams.set("diff", payload.diff);
  return urlObject.toString();
}

function buildHumanReadableLineDiff(
  savedText: string,
  currentText: string,
  filePath: string
): string {
  const savedLines = toLines(savedText);
  const currentLines = toLines(currentText);
  const ops = diffLines(savedLines, currentLines);

  const output: string[] = [];
  output.push(`Diff generated: ${new Date().toISOString()}`);
  output.push(`File: ${filePath}`);
  output.push("Legend: - removed from saved file, + added in current editor text");
  output.push("");

  let savedLine = 1;
  let currentLine = 1;
  let changeCount = 0;

  for (const op of ops) {
    if (op.kind === "equal") {
      savedLine += 1;
      currentLine += 1;
      continue;
    }

    if (op.kind === "remove") {
      output.push(`- [saved:${savedLine}] ${op.line}`);
      savedLine += 1;
      changeCount += 1;
      continue;
    }

    output.push(`+ [current:${currentLine}] ${op.line}`);
    currentLine += 1;
    changeCount += 1;
  }

  if (changeCount === 0) {
    output.push("No line-level changes detected.");
  } else {
    output.push("");
    output.push(`Total changed lines: ${changeCount}`);
  }

  return output.join("\n");
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array<number>(m + 1).fill(0)
  );

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "equal", line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "remove", line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", line: newLines[j] });
      j += 1;
    }
  }

  while (i < n) {
    ops.push({ kind: "remove", line: oldLines[i] });
    i += 1;
  }

  while (j < m) {
    ops.push({ kind: "add", line: newLines[j] });
    j += 1;
  }

  return ops;
}

function toLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  return text.replace(/\r\n/g, "\n").split("\n");
}

function buildDiffOutputPath(documentPath: string): string {
  const dir = path.dirname(documentPath);
  const basename = path.basename(documentPath, path.extname(documentPath));
  const filename = `${basename}-line-diff-${timestampForFilename(new Date())}.txt`;
  return path.join(dir, filename);
}

function timestampForFilename(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}-${hour}${minute}${second}-${ms}`;
}

function getSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("toggleDiffWatcher");
  const modeRaw = config.get<string>("triggerMode", "toggleFile").trim();
  const pollingIntervalRaw = config.get<number>("pollingIntervalMs", 100);
  const timeoutRaw = config.get<number>("httpTimeoutMs", 5000);

  const triggerMode: TriggerMode =
    modeRaw === "httpDirty" ? "httpDirty" : "toggleFile";

  return {
    triggerMode,
    toggleFilePath: config.get<string>("toggleFilePath", "").trim(),
    pollingIntervalMs:
      typeof pollingIntervalRaw === "number" &&
      Number.isFinite(pollingIntervalRaw) &&
      pollingIntervalRaw >= 10
        ? pollingIntervalRaw
        : 100,
    serverBaseUrl: config
      .get<string>("serverBaseUrl", "http://127.0.0.1:1337")
      .trim(),
    dirtyServerBaseUrl: config
      .get<string>("dirtyServerBaseUrl", "")
      .trim(),
    diffServerBaseUrl: config
      .get<string>("diffServerBaseUrl", "")
      .trim(),
    dirtyEndpointPath: config.get<string>("dirtyEndpointPath", "/dirty").trim(),
    diffUploadEndpointPath: config
      .get<string>("diffUploadEndpointPath", "/diff")
      .trim(),
    httpTimeoutMs:
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw >= 100
        ? timeoutRaw
        : 5000
  };
}

function resolveTogglePath(configValue: string): string | undefined {
  if (!configValue) {
    return undefined;
  }

  if (path.isAbsolute(configValue)) {
    return configValue;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return path.join(workspaceFolder.uri.fsPath, configValue);
  }

  return path.resolve(configValue);
}

function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function logThrottled(key: string, message: string): void {
  const now = Date.now();
  const last = lastLogByKey.get(key) ?? 0;
  if (now - last < logWindowMs) {
    return;
  }

  lastLogByKey.set(key, now);
  log(message);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
