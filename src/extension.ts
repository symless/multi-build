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
const reconnectCommand = `multiBuild.reconnect`;
const syncCommand = `multiBuild.sync`;
const defaultBaseUrl = "wss://multi-build-server.symless.workers.dev";
const keepAliveIntervalMillis = 10000; // 10 seconds

var configWatcher: vscode.Disposable | undefined;
var roomSocket: WebSocket | undefined;
var keepAlive: NodeJS.Timeout | undefined;
var connected = false;

export function activate(context: vscode.ExtensionContext) {
  init().catch((error) => {
    handleError(error);
  });

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

  console.log(`${logTag} Registering command: ${reconnectCommand}`);
  context.subscriptions.push(
    vscode.commands.registerCommand(reconnectCommand, async () => {
      try {
        await connectWebSocket();
      } catch (error) {
        handleError(error);
      }
    }),
  );
}

export function deactivate() {
  try {
    stopConfigWatcher();
  } catch (error) {
    handleError(error);
  }

  try {
    disconnectWebSocket();
  } catch (error) {
    handleError(error);
  }
}

async function init() {
  console.log(`${logTag} Initializing`);

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

  console.log(`${logTag} Watching for config changes`);
  configWatcher = vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration(serverConfigKey)) {
      console.log(`${logTag} Config changed for key: ${serverConfigKey}`);
      try {
        await connectWebSocket();
      } catch (error) {
        handleError(error);
      }
    }
  });

  await connectWebSocket();

  console.log(`${logTag} Initialized`);
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

function stopConfigWatcher() {
  console.debug(`${logTag} Stopping config watcher`);

  if (!configWatcher) {
    console.warn(`${logTag} No config watcher to stop`);
    return;
  }

  configWatcher.dispose();
  configWatcher = undefined;

  console.debug(`${logTag} Stopped config watcher`);
}

function getGitAPI() {
  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
  if (!gitExtension) {
    throw new Error(`No Git extension found`);
  }
  const git: GitAPI | undefined = gitExtension.getAPI(1);
  if (!git) {
    throw new Error(`No Git API found`);
  }
  return git;
}

// Always show the list of remotes but pre-select the one that was used last.
// We could save the last used repo in the workspace config, but for now we'll ask.
async function getRepo(currentRepo?: string) {
  const git = getGitAPI();
  const repos = git.repositories.map((repo) => ({
    label: path.basename(repo.rootUri.fsPath),
    description: repo.rootUri.fsPath,
    isFirst: currentRepo === path.basename(repo.rootUri.fsPath),
  }));

  if (repos.length === 0) {
    vscode.window.showErrorMessage(`${extensionName}: No Git repositories found`);
    return null;
  }

  // Put the current repo first in the list, so it's pre-selected.
  // The `picked` property is only for when `canPickMany` is true.
  repos.sort((a, b) => (a.isFirst ? -1 : b.isFirst ? 1 : 0));

  const options = {
    placeHolder: "Select a repository",
    canPickMany: false,
  };

  return await vscode.window.showQuickPick(repos, options).then((item) => item?.label);
}

// If a remote was selected before and it's for the same repo as before, that remote will be used,
// otherwise show all remotes since it's either a new repo or the remote wasn't chosen before.
// Don't show all remotes every time, as this makes it a bit tedious; usually we only want to set
// the remote once and use it for all future syncs. This chan be changed in `settings.json`.
async function getRemote(repoName: string, currentConfig?: { repo?: string; remote?: string }) {
  const { repo: currentRepo, remote: currentRemote } = currentConfig || {};
  if (currentRepo === repoName && currentRemote) {
    console.log(`${logTag} Repo not changed, using existing remote: ${currentRemote}`);
    return currentRemote;
  }

  const git = getGitAPI();
  const repo = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repoName);
  if (!repo) {
    throw new Error(`Repository '${repoName}' not found`);
  }

  const remotes = repo.state.remotes.map((remote) => ({
    label: remote.name,
    description: remote.fetchUrl,
    isFirst: currentRemote === remote.name,
  }));

  if (remotes.length === 0) {
    vscode.window.showErrorMessage(
      `${extensionName}: No remotes found for repository '${repoName}'`,
    );
    return null;
  }

  // Put the current remote first in the list, so it's pre-selected.
  // The `picked` property is only for when `canPickMany` is true.
  remotes.sort((a, b) => (a.isFirst ? -1 : b.isFirst ? 1 : 0));

  const options = {
    placeHolder: "Select a remote",
    canPickMany: false,
  };

  return await vscode.window.showQuickPick(remotes, options).then((item) => item?.label);
}

async function pushRepoSettings() {
  const config = getSyncData();

  const repo = await getRepo(config.repo);
  if (!repo) {
    vscode.window.showErrorMessage(`${extensionName}: Cannot sync, no repo specified`);
    return;
  }

  const remote = await getRemote(repo, config);
  if (!remote) {
    vscode.window.showErrorMessage(`${extensionName}: Cannot sync, no remote specified`);
    return;
  }

  // Always ask the branch name, as this is what changes most often.
  // Copy pasting this from the PR isn't a big deal, and it's not often one we've used before.
  const branch = await vscode.window.showInputBox({
    prompt: "Enter the branch name",
    placeHolder: "hello-branch",
    value: config?.branch || "master",
  });
  if (!branch) {
    vscode.window.showErrorMessage(`${extensionName}: Cannot sync, no branch specified`);
    return;
  }

  const data = { repo, remote, branch };
  console.log(`${logTag} Saving changes to config:`, data);
  await vscode.workspace.getConfiguration().update(syncDataConfigKey, data, true);

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
  console.debug(`${logTag} Sending message: ${type}`, { data });
  roomSocket.send(JSON.stringify({ type, data }));
}

async function handleSyncData(data: { repo: string; remote: string; branch: string }) {
  const { repo, remote, branch } = data;
  if (!repo || !remote || !branch) {
    console.error(`${logTag} Invalid sync message:`, data);
    vscode.window.showErrorMessage(`${extensionName}: Invalid sync message`);
    return;
  }

  console.log(`${logTag} Syncing repo: ${repo}, remote: ${remote}, branch: ${branch}`);

  const checkoutResult = await checkoutBranch(repo, remote, branch);
  if (!checkoutResult) {
    console.warn(`${logTag} Checkout failed, skipping build`);
    return;
  }

  vscode.window.showInformationMessage(
    `${extensionName}: Checked out branch '${branch}' from '${repo}/${remote}'`,
  );

  console.log(`${logTag} CMake configure`);
  await vscode.commands.executeCommand("cmake.configure");

  // Wait a moment for CMake to finish up (or we get "already running" errors).
  console.log(`${logTag} Waiting for CMake`);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(`${logTag} CMake build`);
  await vscode.commands.executeCommand("cmake.build");
}

async function connectWebSocket() {
  const { baseUrl, roomId } = await getServerConfig();

  if (roomSocket) {
    console.log(`${logTag} WebSocket already connected, disconnecting`);
    disconnectWebSocket();
  }

  console.log(`${logTag} Connecting WebSocket, room: ${roomId}`);
  roomSocket = new WebSocket(`${baseUrl}/room/${roomId}`, {
    headers: {
      Authorization: `Bearer ${await getAuthToken()}`,
    },
  });
  connected = true;

  roomSocket.on("open", () => {
    assert(roomSocket);
    console.log(`${logTag} WebSocket connection opened`);
    sendMessage({ type: "hello" });
    keepAlive = setInterval(() => sendMessage({ type: "keep-alive" }), keepAliveIntervalMillis);
  });

  roomSocket.on("message", async (data) => {
    try {
      assert(roomSocket);
      console.debug(`${logTag} WebSocket message received:`, data.toString());
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
        await handleSyncData(message.data);
      } else {
        console.error(`${logTag} Unknown message type: ${message.type}`);
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
    if (!connected) {
      console.log(`${logTag} WebSocket closed (expected)`);
      return;
    }

    const retryDelay = 1000;
    console.warn(
      `${logTag} WebSocket closed unexpectedly, reconnecting in ${retryDelay / 1000} seconds`,
    );
    setTimeout(async () => {
      try {
        await connectWebSocket();
      } catch (error) {
        handleError(error);
      }
    }, retryDelay);
  });
}

function disconnectWebSocket() {
  if (!roomSocket) {
    console.warn(`${logTag} No WebSocket connection to close`);
    return;
  }

  console.log(`${logTag} Closing WebSocket connection`);
  clearInterval(keepAlive);
  connected = false;
  roomSocket.close();
  roomSocket = undefined;
}

async function checkoutBranch(
  repoName: string,
  remoteName: string,
  branchName: string,
): Promise<boolean> {
  console.log(`${logTag} Checking out branch '${branchName}' in repository '${repoName}'`);

  const git = getGitAPI();
  if (git.repositories.length === 0) {
    console.log(`${logTag} No Git repositories found`);
    return false;
  }

  const repo = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repoName);
  if (!repo) {
    console.debug(`${logTag} Repository '${repoName}' not found`);
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
    console.debug(`${logTag} Branch '${branchName}' already exists`);
    await repo.checkout(branchName);
    await repo.pull();
  } else {
    console.debug(`${logTag} Branch '${branchName}' does not exist, creating new branch`);
    await repo.checkout(ref);
    await repo.createBranch(branchName, true, ref);
    await repo.setBranchUpstream(branchName, ref);
  }

  console.log(`${logTag} Checked out branch '${branchName}' in repository ${repoName}`);
  return true;
}
