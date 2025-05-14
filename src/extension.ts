import * as path from "path";
import * as vscode from "vscode";
import { API as GitAPI, GitExtension } from "../typings/git";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import assert from "assert";

const extensionName = "Multi-Build";
const logTag = "[multi-build]";
const serverConfigKey = "multiBuild.server";
const syncDataConfigKey = "multiBuild.syncData";
const startCommand = `multiBuild.start`;
const stopCommand = `multiBuild.stop`;
const reloadCommand = `multiBuild.reload`;
const syncCommand = `multiBuild.sync`;
const defaultBaseUrl = "wss://multi-build-server.symless.workers.dev";
const keepAliveInterval = 10000; // 10 seconds

var configWatcher: vscode.Disposable | undefined;
var workspaceWatcher: vscode.Disposable | undefined;
var roomSocket: WebSocket | undefined;
var keepAlive: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  init().catch((error) => {
    handleError(error);
  });

  console.log(`${logTag} Registering command: ${startCommand}`);
  context.subscriptions.push(
    vscode.commands.registerCommand(startCommand, () => {
      try {
        startWatchers();
      } catch (error) {
        handleError(error);
      }
    }),
  );

  console.log(`${logTag} Registering command: ${stopCommand}`);
  context.subscriptions.push(
    vscode.commands.registerCommand(stopCommand, () => {
      try {
        stopWatchers();
      } catch (error) {
        handleError(error);
      }
    }),
  );

  console.log(`${logTag} Registering command: ${reloadCommand}`);
  context.subscriptions.push(
    vscode.commands.registerCommand(reloadCommand, () => {
      try {
        unload();
        load();
      } catch (error) {
        handleError(error);
      }
    }),
  );

  console.log(`${logTag} Registering command: ${syncCommand}`);
  context.subscriptions.push(
    vscode.commands.registerCommand(syncCommand, async () => {
      try {
        await pushRepoSettings();
      } catch (error) {
        handleError(error);
      }
    }),
  );
}

export function deactivate() {
  try {
    unload();
  } catch (error) {
    handleError(error);
  }
}

async function init() {
  console.log(`${logTag} Initializing extension`);

  const existingServerConfig = await getServerConfig();
  if (!existingServerConfig) {
    vscode.window.showErrorMessage(`${extensionName}: No server config found`);
    return;
  }

  const { baseUrl } = existingServerConfig;

  if (!baseUrl) {
    vscode.window.showErrorMessage(`${extensionName}: No server base URL found`);
    return;
  }

  var roomId: string;
  const { roomId: existingRoomId } = existingServerConfig;
  if (existingRoomId) {
    console.log(`${logTag} Using existing room ID: ${existingRoomId}`);
    roomId = existingRoomId;
  } else {
    roomId = randomUUID();
    console.log(`${logTag} Saving new room ID: ${existingRoomId}`);
    await vscode.workspace.getConfiguration().update(serverConfigKey, { roomId }, true);
  }

  console.log(`${logTag} Loading for first time`);
  load();

  console.log(`${logTag} Extension initialized`);
}

function unload() {
  stopWatchers();
}

function load() {
  startWatchers();
  connectWebSocket();
}

function handleError(error: unknown) {
  if (error instanceof Error) {
    console.error(`${logTag} Error:`, error);
    vscode.window.showErrorMessage(`${extensionName}: ${error}`);
  } else {
    console.error(`${logTag} Unknown error: ${error}`);
    vscode.window.showErrorMessage(`${extensionName}: Unknown error`);
  }
}

function startWatchers() {
  console.log(`${logTag} Starting watchers`);

  if (configWatcher) {
    vscode.window.showErrorMessage(`${extensionName}: Already started`);
    return;
  }

  console.log(`${logTag} Watching for config changes`);
  configWatcher = vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration(serverConfigKey)) {
      console.log(`${logTag} Config changed for key: ${serverConfigKey}`);
      try {
        connectWebSocket();
      } catch (error) {
        handleError(error);
      }
    }
  });

  console.log(`${logTag} Watching for workspace changes`);
  workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
    console.log(`${logTag} Workspace changed`);
    if (event.added.length > 0) {
      console.log(`${logTag} Added workspace folder: ${event.added[0].name}`);
      try {
        connectWebSocket();
      } catch (error) {
        handleError(error);
      }
    }
  });
}

function stopWatchers() {
  console.log(`${logTag} Stopping watchers`);

  if (configWatcher) {
    console.log(`${logTag} Stopping config watcher`);
    configWatcher.dispose();
    configWatcher = undefined;
  } else {
    console.warn(`${logTag} No config watcher to stop`);
  }

  if (workspaceWatcher) {
    console.log(`${logTag} Stopping workspace watcher`);
    workspaceWatcher.dispose();
    workspaceWatcher = undefined;
  } else {
    console.warn(`${logTag} No workspace watcher to stop`);
  }

  console.log(`${logTag} Stopped watchers`);
}

async function getRepo() {
  return await vscode.window.showInputBox({
    prompt: "Enter the repository name",
    placeHolder: "hello-repo",
  });
}

async function getRemote() {
  return await vscode.window.showInputBox({
    prompt: "Enter the remote name",
    placeHolder: "hello-remote",
  });
}

async function pushRepoSettings() {
  const config = getSyncData();

  const repo = config.repo ?? (await getRepo());
  if (!repo) {
    vscode.window.showErrorMessage(`${extensionName}: No repo provided`);
    return;
  }

  const remote = config.remote ?? (await getRemote());
  if (!remote) {
    vscode.window.showErrorMessage(`${extensionName}: No remote provided`);
    return;
  }

  const branch = await vscode.window.showInputBox({
    prompt: "Enter the branch name",
    placeHolder: "hello-branch",
    value: config?.branch || "master",
  });
  if (!branch) {
    vscode.window.showErrorMessage(`${extensionName}: No branch provided`);
    return;
  }

  const data = { repo, remote, branch };
  console.log(`${logTag} Saving changes to config:`, data);
  await vscode.workspace.getConfiguration().update(syncDataConfigKey, data, true);

  if (!roomSocket) {
    throw new Error("No WebSocket connection found");
  }

  console.log(`${logTag} Pushing changes to server`);
  sendMessage({ type: "sync", data });
}

async function getServerConfig() {
  const config = vscode.workspace.getConfiguration(serverConfigKey);
  const baseUrl = config.get<string>("baseUrl") || defaultBaseUrl;
  const roomId = config.get<string>("roomId");
  return { baseUrl, roomId };
}

function getSyncData() {
  const config = vscode.workspace.getConfiguration(syncDataConfigKey);
  const repo = config.get<string>("repo");
  const remote = config.get<string>("remote");
  const branch = config.get<string>("branch");
  return { repo, remote, branch };
}

async function getAuthToken() {
  console.log(`${logTag} Getting auth token`);
  const session = await vscode.authentication.getSession("github", ["read:user"], {
    createIfNone: true,
  });
  if (!session) {
    throw new Error("No GitHub auth session found");
  }
  console.log(`${logTag} Auth session found: ${session.id}`);
  return session.accessToken;
}

function sendMessage({ type, data }: { type: string; data?: unknown }) {
  if (!roomSocket) {
    throw new Error("No WebSocket connection found");
  }
  console.log(`${logTag} Sending message: ${type}`, { data });
  roomSocket.send(JSON.stringify({ type, data }));
}

async function handleSyncMessage(data: { repo: string; remote: string; branch: string }) {
  const { repo, remote, branch } = data;
  if (!repo || !remote || !branch) {
    console.error(`${logTag} Invalid sync message:`, data);
    vscode.window.showErrorMessage(`${extensionName}: Invalid sync message`);
    return;
  }

  console.log(`${logTag} Syncing repo: ${repo}, remote: ${remote}, branch: ${branch}`);

  const checkoutResult = await checkoutBranch(repo, remote, branch);
  if (!checkoutResult) {
    console.log(`${logTag} Checkout failed, skipping build`);
    return;
  }

  vscode.window.showInformationMessage(`${extensionName}: Checked out: ${branch}`);

  console.log(`${logTag} CMake configure`);
  await vscode.commands.executeCommand("cmake.configure");

  // Wait a moment for CMake to finish up (or we get "already running" errors).
  console.log(`${logTag} Waiting for CMake`);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(`${logTag} CMake build`);
  await vscode.commands.executeCommand("cmake.build");
}

async function connectWebSocket() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    console.log(`${logTag} No workspace folders found, skipping`);
    return;
  }

  const { baseUrl, roomId } = await getServerConfig();

  if (roomSocket) {
    console.log(`${logTag} Closing existing WebSocket connection`);
    clearInterval(keepAlive);
    roomSocket.close();
    roomSocket = undefined;
  }

  console.log(`${logTag} Connecting WebSocket, room: ${roomId}`);
  roomSocket = new WebSocket(`${baseUrl}/room/${roomId}`, {
    headers: {
      Authorization: `Bearer ${await getAuthToken()}`,
    },
  });

  roomSocket.on("open", () => {
    assert(roomSocket);
    console.log(`${logTag} WebSocket connection opened`);
    sendMessage({ type: "hello" });
    keepAlive = setInterval(() => sendMessage({ type: "keep-alive" }), keepAliveInterval);
  });

  roomSocket.on("message", async (data) => {
    try {
      assert(roomSocket);
      console.log(`${logTag} WebSocket message received:`, data.toString());
      const message = JSON.parse(data.toString());
      if (message.type === "hello") {
        console.log(`${logTag} Hello back message received`);
      } else if (message.type === "ack") {
        console.debug(`${logTag} Ack message received`);
      } else if (message.type === "error") {
        console.error(`${logTag} Error message received: ${message.message}`);
        vscode.window.showErrorMessage(`${extensionName}: ${message.message}`);
      } else if (message.type === "sync") {
        console.log(`${logTag} Sync message received:`, message.data);
        await handleSyncMessage(message.data);
      } else {
        console.log(`${logTag} Unknown message type: ${message.type}`);
        vscode.window.showErrorMessage(`${extensionName}: Unknown message type: ${message.type}`);
      }
    } catch (error) {
      handleError(error);
    }
  });

  roomSocket.on("error", (error) => {
    console.error(`${logTag} WebSocket error: ${error}`);
    vscode.window.showErrorMessage(`${extensionName}: Connection error: ${error}`);
  });

  roomSocket.on("close", () => {
    console.log(`${logTag} WebSocket connection closed`);
    const waitTime = 5000;
    vscode.window.showErrorMessage(
      `${extensionName}: Remote connection closed, reconnecting in ${waitTime / 1000} seconds`,
    );
    setTimeout(() => connectWebSocket(), waitTime);
  });
}

async function checkoutBranch(
  repoName: string,
  remoteName: string,
  branchName: string,
): Promise<boolean> {
  console.log(`${logTag} Checking out branch '${branchName}' in repository '${repoName}'`);

  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
  const git: GitAPI | undefined = gitExtension?.getAPI(1);

  if (!git || git.repositories.length === 0) {
    console.log(`${logTag} No Git extension found or no repositories found`);
    return false;
  }

  const repo = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repoName);
  if (!repo) {
    console.log(`${logTag} Repository '${repoName}' not found`);
    return false;
  }

  console.log(`${logTag} Found repository: ${repo.rootUri.fsPath}`);

  const ref = `${remoteName}/${branchName}`;
  try {
    await repo.fetch(remoteName, branchName);
  } catch (error) {
    vscode.window.showErrorMessage(
      `${extensionName}: Error fetching Git branch '${ref}': ${error}`,
    );
    return false;
  }

  if (repo.getBranch(branchName) !== undefined) {
    console.log(`${logTag} Branch '${branchName}' already exists`);
    await repo.checkout(branchName);
    await repo.pull();
  } else {
    console.log(`${logTag} Branch '${branchName}' does not exist, creating new branch`);
    await repo.checkout(ref);
    await repo.createBranch(branchName, true, ref);
    await repo.setBranchUpstream(branchName, ref);
  }

  console.log(`${logTag} Checked out branch '${branchName}' in repository ${repoName}`);
  return true;
}
