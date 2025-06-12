import * as path from "path";
import * as vscode from "vscode";
import { API as GitAPI, GitExtension } from "../typings/git";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import assert from "assert";

const extensionName = "Multi-Build";
const logTag = "[multi-build]";
const cargoLogTag = "[cargo-e]";
const serverConfigKey = "multiBuild.server";
const syncDataConfigKey = "multiBuild.syncData";
const reconnectCommand = `multiBuild.reconnect`;
const syncCommand = `multiBuild.sync`;
const showRoomIdCommand = "multiBuild.showRoomId";
const defaultBaseUrl = "wss://multi-build-server.symless.workers.dev";
const keepAliveIntervalMillis = 10000; // 10 seconds

var configWatcher: vscode.Disposable | undefined;
var activeSocket: WebSocket | undefined;
var keepAlive: NodeJS.Timeout | undefined;
var connected = false;

export function activate(context: vscode.ExtensionContext) {
  console.log(`${logTag} Activating ${extensionName} v${context.extension.packageJSON.version}`);
  vscode.window.showInformationMessage(`${extensionName} v${context.extension.packageJSON.version} loaded successfully.`);

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

  // Register command to show and edit the current room ID
  context.subscriptions.push(
    vscode.commands.registerCommand(showRoomIdCommand, async () => {
      const config = await getServerConfig();
      const roomId = await showRoomIdPrompt(config.roomId);
      if (roomId !== config.roomId) {
        await updateServerConfig({ ...config, roomId });
      } else {
        vscode.window.showInformationMessage(`${extensionName}: Room ID did not change`);
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

  const config = await getServerConfig();
  console.log(`${logTag} Server config:`, config);

  if (!config.roomId) {
    const roomId = await showRoomIdPrompt(config.roomId);
    await updateServerConfig({ ...config, roomId });
  } else {
    console.log(`${logTag} Using existing room ID: ${config.roomId}`);
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

async function updateServerConfig(newConfig: { baseUrl?: string; roomId?: string }) {
  await vscode.workspace.getConfiguration().update(serverConfigKey, newConfig, true);
}

async function showRoomIdPrompt(existing: string | null) {
  // Prompt the user for a room ID.
  // Hopefully they don't enter something that is already in use, as 'room in use' UX is a bit
  // unintuitive/undefined right now (you'll most likely get an authentication error).
  if (existing) {
    console.log(`${logTag} Using existing room ID: ${existing}`);
    return await vscode.window.showInputBox({
      ignoreFocusOut: true,
      value: existing,
      prompt: `${extensionName}: The room ID must match on all computers.`,
    });
  } else {
    console.log(`${logTag} No existing room ID, generating a new one`);
    return await vscode.window.showInputBox({
      ignoreFocusOut: true,
      value: randomUUID(),
      prompt:
        `${extensionName}: ` +
        "First timers can use this uniquely generated room ID, " +
        "or copy-paste an existing ID from another computer. " +
        "The room ID must match on all computers.",
    });
  }
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
    // Not exception, as this can happen if the user runs sync command with no repos open.
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
    throw new Error(`No remotes found for repository '${repoName}'`);
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
  const roomId = config.get<string>("roomId") || null;
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
  if (!activeSocket) {
    throw new Error("No WebSocket connection found");
  }
  console.debug(`${logTag} Sending message: ${type}`, { data });
  activeSocket.send(JSON.stringify({ type, data }));
}

async function handleSyncData(data: { repo: string; remote: string; branch: string }) {
  const { repo, remote, branch } = data;
  if (!repo || !remote || !branch) {
    console.error(`${logTag} Invalid sync message:`, data);
    throw new Error("Invalid sync message");
  }

  console.log(`${logTag} Syncing repo: ${repo}, remote: ${remote}, branch: ${branch}`);

  const checkoutResult = await checkoutBranch(repo, remote, branch);
  if (!checkoutResult) {
    // Not necessarily an error; maybe the repo doesn't exist in this workspace.
    console.debug(`${logTag} No Git checkout happened, skipping build`);
    return;
  }

  vscode.window.showInformationMessage(
    `${extensionName}: Checked out branch '${branch}' from '${repo}/${remote}'`,
  );
  // Check if Cargo.toml exists in the repo root
  const git = getGitAPI();
  const repoObj = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repo);
  if (repoObj) {
    const cargoFiles = await vscode.workspace.findFiles("**/Cargo.toml");
    console.debug(`${logTag} Found Cargo.toml files:`, cargoFiles.map(f => f.fsPath));
    if (cargoFiles.length === 0) {
      vscode.window.showErrorMessage(`${extensionName}: No Cargo.toml files found in the workspace.`);
      return;
    }

    const selectedFile = await vscode.window.showQuickPick(
      cargoFiles.map((file) => ({
        label: path.basename(file.fsPath),
        description: file.fsPath,
        filePath: file.fsPath,
      })),
      {
        placeHolder: "Select a Cargo.toml file",
      },
    );

    if (!selectedFile) {
      vscode.window.showErrorMessage(`${extensionName}: No file selected.`);
      return;
    }
    const selectedTarget = await listCargoETargets(selectedFile.filePath).catch((error) => {
      vscode.window.showErrorMessage(`${cargoLogTag} Error listing Cargo-e targets: ${error}`);
      return null;
    });
    if (!selectedTarget) {
      console.warn(`${cargoLogTag} No target selected, running default Cargo-e command`);
    }
    const selectedDir = path.dirname(selectedFile.filePath);
    console.log(`${cargoLogTag} Found Cargo.toml, running 'cargo-e' in ${selectedDir}`);
    const terminal = vscode.window.createTerminal({
      name: "Cargo Build",
      cwd: selectedDir,
    });
    terminal.show();
    const targetName = selectedTarget ? selectedTarget.label : undefined;
    const cargoCommand = targetName ? `cargo-e --manifest-path ${selectedFile.filePath} --target ${targetName}` : `cargo-e --manifest-path ${selectedFile.filePath}`;
    terminal.sendText(cargoCommand);

    // Send WebSocket message to synchronize with other systems
    sendMessage({
      type: "cargo-e",
      data: {
        manifestPath: selectedFile.filePath,
        target: targetName,
      },
    });
    return;
  }

  // Check if CMakeLists.txt exists in the repo root
  const cmakeFiles = await vscode.workspace.findFiles("**/CMakeLists.txt");
  if (cmakeFiles.length > 0) {
    console.log(`${logTag} Found CMakeLists.txt files:`, cmakeFiles.map(f => f.fsPath));
    console.log(`${logTag} CMake configure`);
    await vscode.commands.executeCommand("cmake.configure");

    // Wait a moment for CMake to finish up (or we get "already running" errors).
    console.log(`${logTag} Waiting for CMake`);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log(`${logTag} CMake build`);
    await vscode.commands.executeCommand("cmake.build");
  } else {
    vscode.window.showErrorMessage(`${extensionName}: No CMakeLists.txt files found in the workspace.`);
  }
}

// Add logic to run `cargo-e --json-all-targets` and list targets
async function listCargoETargets(manifestPath: string): Promise<{ label: string; description: string; detail: string } | null> {
  try {
    console.log(`${cargoLogTag} Listing Cargo-e targets for manifest: ${manifestPath}`);
    const { exec } = await import("child_process");
    const output = await new Promise<string>((resolve, reject) => {
      exec(
        `cargo-e --json-all-targets --manifest-path "${manifestPath}"`,
        { cwd: path.dirname(manifestPath) },
        (error, stdout, stderr) => {
          if (error) {
            reject(stderr || error.message);
          } else {
            resolve(stdout);
          }
        }
      );
    });

    console.log(`${cargoLogTag} Raw output from cargo-e:`, output);

    // Parse the JSON output
    let targets: any[];
    try {
      targets = JSON.parse(output);
      console.log(`${cargoLogTag} Parsed JSON targets:`, targets);
      if (!Array.isArray(targets) || targets.length === 0) {
        vscode.window.showWarningMessage(`${cargoLogTag} No targets found in output.`);
        return null;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`${cargoLogTag} Failed to parse JSON output: ${error}`);
      return null;
    }

    // Extract target display names
    const targetOptions: { label: string; description: string; detail: string }[] = targets.map((target: any) => ({
      label: target.name || "unknown",
      description: target.kind || "",
      detail: target.manifest_path || "",
    }));

    console.log(`${cargoLogTag} Target options for Quick Pick:`, targetOptions);

    // Show the targets in a Quick Pick menu
    // Add lifecycle logs and a delay for debugging
    console.log(`${cargoLogTag} Showing Quick Pick menu.`);
    try {
      // Use showQuickPick and keep the menu open until user selects or cancels.
      // Prevent auto-closing by awaiting the promise and not triggering any other UI.
      const selectedTarget = await vscode.window.showQuickPick(targetOptions, {
        placeHolder: "Select a target to execute",
        ignoreFocusOut: true, // Keeps the picker open if focus is lost
      });

      console.log(`${cargoLogTag} Quick Pick menu dismissed.`);

      if (!selectedTarget) {
        // Only show info if there were options but user cancelled
        if (targetOptions.length > 0) {
          vscode.window.showInformationMessage(`${cargoLogTag} No target selected.`);
        }
        console.log(`${cargoLogTag} Quick Pick cancelled by user.`);
        return null;
      }

      console.log(`${cargoLogTag} User selected target:`, selectedTarget);
      return selectedTarget;
    } catch (error) {
      console.error(`${cargoLogTag} Error during Quick Pick:`, error);
      vscode.window.showErrorMessage(`${cargoLogTag} Error during target selection: ${error}`);
      return null;
    } finally {
      // Add a delay to observe the Quick Pick menu behavior
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (error) {
    vscode.window.showErrorMessage(`${cargoLogTag} Error listing targets: ${error}`);
    console.error(`${cargoLogTag} Error details:`, error);
    return null;
  }
}

async function connectWebSocket() {
  const { baseUrl, roomId } = await getServerConfig();
  if (!roomId) {
    // TODO: Handle room ID being removed from config while extension is running.
    throw new Error("No room ID in config");
  }

  if (activeSocket) {
    console.log(`${logTag} WebSocket already connected, disconnecting`);
    disconnectWebSocket();
  }

  console.log(`${logTag} Connecting WebSocket, room: ${roomId}`);
  const newSocket = new WebSocket(`${baseUrl}/room/${roomId}`, {
    headers: {
      Authorization: `Bearer ${await getAuthToken()}`,
    },
  });

  // Replace the old socket with the new one; do not use `activeSocket` for the event handlers,
  // as it may be a different socket if the connection was closed and re-opened.
  activeSocket = newSocket;
  connected = true;

  newSocket.on("open", () => {
    assert(newSocket, "WebSocket is not defined on open");
    console.log(`${logTag} WebSocket connection opened`);
    sendMessage({ type: "hello" });
    keepAlive = setInterval(() => sendMessage({ type: "keep-alive" }), keepAliveIntervalMillis);
  });

  newSocket.on("message", async (data) => {
    if (!newSocket) {
      // Not an exception, as this happens in a race condition when the socket is closed
      // (e.g. when reconnecting) just as a new message is coming in.
      console.error(`${logTag} WebSocket message received, but socket was closed`);
      return;
    }

    try {
      console.debug(`${logTag} WebSocket message received:`, data.toString());
      const message = JSON.parse(data.toString());
      if (message.type === "hello") {
        console.log(`${logTag} Hello back message received`);
      } else if (message.type === "ack") {
        console.debug(`${logTag} Ack message received`);
      } else if (message.type === "error") {
        console.error(`${logTag} Error message received: ${message.message}`);
      } else if (message.type === "sync") {
        console.log(`${logTag} Sync message received:`, message.data);
        await handleSyncData(message.data);
      } else {
        throw new Error(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      handleError(error);
    }
  });

  newSocket.on("error", (error) => {
    console.error(`${logTag} WebSocket error: ${error}`);
  });

  newSocket.on("close", () => {
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
  if (!activeSocket) {
    console.warn(`${logTag} No WebSocket connection to close`);
    return;
  }

  console.log(`${logTag} Closing WebSocket connection`);
  clearInterval(keepAlive);
  connected = false;
  activeSocket.close();
  activeSocket = undefined;
}

async function checkoutBranch(
  repoName: string,
  remoteName: string,
  branchName: string,
): Promise<boolean> {
  const git = getGitAPI();
  if (git.repositories.length === 0) {
    console.log(`${logTag} No Git repositories found`);
    return false;
  }

  const repo = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repoName);
  if (!repo) {
    console.log(`${logTag} Skipping checkout, no repo with name '${repoName}'`);
    return false;
  }

  console.log(`${logTag} Checking out branch '${branchName}' in repository ${repoName}`);

  const ref = `${remoteName}/${branchName}`;
  try {
    await repo.fetch(remoteName, branchName);
  } catch (error) {
    // Not an exception, as expected when user enters bad branch name.
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
