import * as path from "path";
import * as vscode from "vscode";
import { API as GitAPI, GitExtension } from "../typings/git";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import assert from "assert";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

const extensionName = "Multi-Build";
const logTag = "[multi-build]";
const cargoLogTag = "[cargo-e]";
const serverConfigKey = "multiBuild.server";
const syncDataConfigKey = "multiBuild.syncData";
const reconnectCommand = `multiBuild.reconnect`;
const syncCommand = `multiBuild.sync`;
const showRoomIdCommand = "multiBuild.showRoomId";
const updateAndInstallCommand = "multiBuild.updateAndInstall";
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

  // Register command to update, package, and install the extension
  context.subscriptions.push(
    vscode.commands.registerCommand(updateAndInstallCommand, async () => {
      try {
        // Use a visible terminal for all steps
        const terminal = vscode.window.createTerminal({ name: "Multi-Build Update" });
        terminal.show();
        // Use VS Code Git API to pull latest code instead of terminal command
        try {
          const git = getGitAPI();
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
          const repo = git.repositories.find(r => r.rootUri.fsPath === workspacePath);
          if (repo) {
            // Pulls the currently checked out branch
            await repo.pull();
            vscode.window.showInformationMessage("Multi-Build: Pulled latest code using VS Code Git API.");
          } else {
            vscode.window.showWarningMessage("Multi-Build: No Git repository found for workspace, skipping pull.");
          }
        } catch (err) {
          vscode.window.showWarningMessage(`Multi-Build: Git pull failed: ${err}`);
        }

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const pkg = require(path.join(workspacePath, "package.json"));
        const version = pkg.version;
        const vsixName = `multi-build-${version}.vsix`;
        const vsixPath = path.join(workspacePath, vsixName);
        const fs = require("fs");
        let prevMtime = 0;
        if (fs.existsSync(vsixPath)) {
          prevMtime = fs.statSync(vsixPath).mtime.getTime();
        }
        vscode.window.showInformationMessage(`Multi-Build v${version}: Pulling latest code in terminal...`);

        // Clean up old VSIX files before packaging (remove glob, just delete known file)
        if (fs.existsSync(vsixPath)) {
          try { fs.unlinkSync(vsixPath); } catch (e) { /* ignore */ }
        }
        vscode.window.showInformationMessage("Multi-Build: Deleted previous VSIX file before packaging.");

        terminal.sendText("npm run package");
        vscode.window.showInformationMessage(`Multi-Build v${version}: Packaging extension in terminal...`);
        // Wait for the new .vsix file to be created/updated (remove glob, just check vsixPath)
        const waitForVsix = async () => {
          for (let i = 0; i < 30; ++i) { // up to ~15 seconds
            if (fs.existsSync(vsixPath)) {
              const mtime = fs.statSync(vsixPath).mtime.getTime();
              if (mtime > prevMtime) {
                return vsixPath;
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
          return undefined;
        };
        const foundVsix = await waitForVsix();
        if (!foundVsix) {
          vscode.window.showErrorMessage(`Multi-Build: ${vsixName} not found or not updated after packaging. Make sure packaging succeeded.`);
          return;
        }
        vscode.window.showInformationMessage(`Multi-Build v${version}: Installing extension from VSIX...`);
        // Install the correct VSIX using VS Code's API
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(foundVsix));
        // Broadcast a refresh command to all connected instances after successful upgrade
        vscode.commands.executeCommand('workbench.action.reloadWindow');
        if (roomSocket) {
          sendMessage({ type: "refresh-all-windows" });
          vscode.window.showInformationMessage("Multi-Build: Refresh command sent to all connected instances.");
        } else {
          vscode.window.showInformationMessage("Multi-Build: No WebSocket connection (roomSocket is 0), not refreshing other code instances.");
        }
        vscode.window.showInformationMessage(`Multi-Build: Pulled, packaged, and installed ${vsixName} (v${version})`);
      } catch (err) {
        vscode.window.showErrorMessage(`Multi-Build: Update/install failed: ${err}`);
      }
    })
  );
  // Add a command to broadcast update-and-install to all machines
  context.subscriptions.push(
    vscode.commands.registerCommand("multiBuild.broadcastUpdateAndInstall", async () => {
      sendMessage({ type: "update-and-install" });
      vscode.window.showInformationMessage("Multi-Build: Sent update/install command to all machines in the room.");
    })
  );

  // Create a status bar item to display the current version
  const versionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  versionStatusBarItem.text = `$(tag) ${extensionName} v${context.extension.packageJSON.version}`;
  versionStatusBarItem.tooltip = "Current version of Multi-Build extension";
  versionStatusBarItem.show();
  context.subscriptions.push(versionStatusBarItem);
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
  // Try to get the current branch from the selected repo
  let branch: string | undefined = config?.branch;
  if (!branch) {
    try {
      const git = getGitAPI();
      const repoObj = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repo);
      branch = repoObj?.state.HEAD?.name;
    } catch (e) {
      // ignore error, fallback to default
    }
  }
  if (!branch) {
    branch = "master";
  }
  branch = await vscode.window.showInputBox({
    prompt: "Enter the branch name",
    placeHolder: "hello-branch",
    value: branch || "master",
  });
  if (!branch) {
    vscode.window.showErrorMessage(`${extensionName}: Cannot sync, no branch specified`);
    return;
  }

  // Check for Cargo.toml files
  const cargoFiles = await vscode.workspace.findFiles("**/Cargo.toml");
  let manifestPath: string | undefined = undefined;
  let target: string | undefined = undefined;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let cargoSelected = false;
  if (cargoFiles.length > 0 && workspaceFolder) {
    vscode.window.showInformationMessage(`Multi-Build: Found ${cargoFiles.length} Cargo.toml file(s) in the workspace.`);
    // Sort the files alphabetically by their paths
    const sortedCargoFiles = cargoFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

    console.log(`${cargoLogTag} Found and sorted Cargo.toml files:`, sortedCargoFiles.map(f => f.fsPath));

    const selectedFile = await vscode.window.showQuickPick(
      sortedCargoFiles.map((file) => ({
        label: path.basename(file.fsPath),
        description: file.fsPath,
        filePath: file.fsPath,
      })),
      {
        placeHolder: "Select a Cargo.toml file (Esc to skip)",
      },
    );
    if (selectedFile) {
      // Store manifestPath as relative to workspace root
      manifestPath = path.relative(workspaceFolder, selectedFile.filePath);
      const selectedTarget = await listCargoETargets(selectedFile.filePath).catch((error) => {
        vscode.window.showErrorMessage(`${cargoLogTag} Error listing Cargo-e targets: ${error}`);
        return null;
      });
      if (!selectedTarget) {
        console.warn(`${cargoLogTag} No target selected, running default Cargo-e command`);
      }
      target = selectedTarget ? selectedTarget.label : undefined;
      cargoSelected = true;
    }
  }

  // Only include manifestPath/target if a Cargo.toml was selected
  const data: any = { repo, remote, branch };
  if (cargoSelected && manifestPath) { data.manifestPath = manifestPath; }
  if (cargoSelected && target) { data.target = target; }

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
  const manifestPath = config.get<string>("manifestPath");
  const target = config.get<string>("target");
  return { repo, remote, branch, manifestPath, target };
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
  // Don't show or send keep-alive messages with data
  if (type === "keep-alive") {
    console.debug(`${logTag} Sending message: ${type}`, { data });
    roomSocket.send(JSON.stringify({ type, data }));
    return;
  }
  vscode.window.showInformationMessage(`Multi-Build: Sending message: ${type}${data ? ", data: " + JSON.stringify(data) : ""}`);
  console.debug(`${logTag} Sending message: ${type}`, { data });
  activeSocket.send(JSON.stringify({ type, data }));
}

async function handleSyncData(data: { repo: string; remote: string; branch: string; manifestPath?: string; target?: string }) {
  const { repo, remote, branch, manifestPath, target } = data;
  if (!repo || !remote || !branch) {
    console.error(`${logTag} Invalid sync message:`, data);
    throw new Error("Invalid sync message");
  }
  try {
  const git = getGitAPI();
  const currentRepoObj = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repo);
  if (!currentRepoObj) {
    vscode.window.showWarningMessage(`${extensionName}: The repository '${repo}' does not match any open repository in this workspace.`);
    return;
  }
  console.log(`${logTag} Syncing repo: ${repo}, remote: ${remote}, branch: ${branch}`);
  const checkoutResult = await checkoutBranch(repo, remote, branch);
  if (!checkoutResult) {
    // Not necessarily an error; maybe the repo doesn't exist in this workspace.
    console.debug(`${logTag} No Git checkout happened, skipping build`);
    return;
  }
  vscode.window.showInformationMessage(`${extensionName}: Synced to branch '${branch}' in repository '${repo}'.`);
  // Check if Cargo.toml exists in the repo root
  const repoObj = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repo);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Info: repoObj is the VS Code Git repository object for the selected repo, or undefined if not found.
  // Info: workspaceFolder is the absolute path to the first workspace folder, or undefined if not open.
  vscode.window.showInformationMessage(
    `${extensionName}: Synced to branch '${branch}' in repository '${repo}' '${workspaceFolder}'.`
  );
  if (repoObj && workspaceFolder) {
    let selectedFilePath = manifestPath ? path.resolve(workspaceFolder, ...manifestPath.split(/[\\\/]/)) : undefined;
    let targetName = target;
    if (manifestPath && targetName) {
      await vscode.window.showInformationMessage(
        `${extensionName}: Using Cargo manifest: ${manifestPath}, target: ${targetName} selectedPath: ${selectedFilePath}`
      );
    } else if (manifestPath) {
      await vscode.window.showInformationMessage(
        `${extensionName}: Using Cargo manifest: ${manifestPath}`
      );
    } else if (targetName) {
      await vscode.window.showInformationMessage(
        `${extensionName}: Using Cargo target: ${targetName}`
      );
    }
    if (!selectedFilePath) {
      let selectedFile: { label: string; description: string; filePath: string } | undefined = undefined;

      // If manifestPath and target are already defined, use those directly
      if (manifestPath && target) {
        selectedFile = {
          label: path.basename(manifestPath),
          description: manifestPath,
          filePath: manifestPath,
        };
        // No need to prompt user, just use provided values
      } else {
        const cargoFiles = await vscode.workspace.findFiles("**/Cargo.toml");
        console.debug(`${logTag} Found Cargo.toml files:`, cargoFiles.map(f => f.fsPath));
        if (cargoFiles.length > 0) {
          // Sort the files alphabetically by their paths
          const sortedCargoFiles = cargoFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

          console.log(`${cargoLogTag} Found and sorted Cargo.toml files:`, sortedCargoFiles.map(f => f.fsPath));

          selectedFile = await vscode.window.showQuickPick(
        sortedCargoFiles.map((file) => ({
          label: path.basename(file.fsPath),
          description: file.fsPath,
          filePath: file.fsPath,
        })),
        {
          placeHolder: "Select a Cargo.toml file",
        },
          );
          if (!selectedFile) {
        // User cancelled selection, silently continue to CMake/package.json handling
          }
        } else {
          // No Cargo.toml files found, silently continue to CMake/package.json handling
        }
      }
      if (selectedFile) {
        selectedFilePath = selectedFile.filePath;
        // Prompt for target if not provided
        const selectedTarget = await listCargoETargets(selectedFilePath).catch((error) => {
          vscode.window.showErrorMessage(`${cargoLogTag} Error listing Cargo-e targets: ${error}`);
          return null;
        });
        if (!selectedTarget) {
          console.warn(`${cargoLogTag} No target selected, running default Cargo-e command`);
        }
        targetName = selectedTarget ? selectedTarget.label : undefined;
        handleCargoECommand(selectedFilePath, targetName, workspaceFolder);
        // Send WebSocket message to synchronize with other systems
        sendMessage({
          type: "cargo-e",
          data: {
            repo,
            remote,
            branch,
            manifestPath: selectedFilePath,
            target: targetName,
          },
        });

 
      } else {
        await vscode.window.showErrorMessage(`${extensionName}: No Cargo.toml selected, skipping Cargo build.`);
      }
    } else {
      const posixManifestPath = selectedFilePath.split(path.sep).join(path.posix.sep);
      const selectedDir = path.dirname(path.resolve(workspaceFolder, selectedFilePath));
      console.log(`${cargoLogTag} Preparing to run 'cargo-e' in ${selectedDir}`);

      const terminal = vscode.window.createTerminal({
        name: targetName ? `${targetName}` : "Cargo Build",
        cwd: selectedDir,
      });
      terminal.show();

      const cargoCommand = targetName
        ? `cargo-e --manifest-path "${posixManifestPath}" --target ${targetName}`
        : `cargo-e --manifest-path "${posixManifestPath}"`;
      console.log(`${cargoLogTag} Executing command: ${cargoCommand}`);
      terminal.sendText(cargoCommand);
    }
  } else {
    console.warn(`${logTag} No Git repository found for workspace, skipping Cargo build.`);
    await vscode.window.showWarningMessage(`${extensionName}: No Git repository found for workspace, skipping Cargo build.`);
  }

  // Check if CMakeLists.txt exists in the repo root
  const cmakeFiles = await vscode.workspace.findFiles("**/CMakeLists.txt");
  if (cmakeFiles.length > 0) {
    // Filter out CMakeLists.txt files in 'target' directories
    const filteredCmakeFiles = cmakeFiles.filter(f => !/[/\\]target[/\\]/.test(f.fsPath));
    if (filteredCmakeFiles.length === 0) {
      console.log(`${logTag} All CMakeLists.txt files are in 'target' directories, skipping CMake build.`);
      return;
    }
    // If there are multiple, let the user pick which one to use
    let cmakeFileToUse = filteredCmakeFiles[0];
    if (filteredCmakeFiles.length > 1) {
      const picked = await vscode.window.showQuickPick(
      filteredCmakeFiles.map(f => ({
        label: path.basename(f.fsPath),
        description: f.fsPath,
        file: f
      })),
      { placeHolder: "Select a CMakeLists.txt file to use for build" }
      );
      if (!picked) {
      vscode.window.showInformationMessage(`${logTag} No CMakeLists.txt selected, skipping CMake build.`);
      return;
      }
      cmakeFileToUse = picked.file;
    }
    // Optionally, set the workspace folder to the directory containing the selected CMakeLists.txt
    const cmakeDir = path.dirname(cmakeFileToUse.fsPath);
    console.log(`${logTag} Using CMakeLists.txt in: ${cmakeDir}`);
    console.debug(`${logTag} Using CMakeLists.txt in: ${cmakeDir}`);
    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cmakeDir), false);

    console.log(`${logTag} Found CMakeLists.txt files:`, cmakeFiles.map(f => f.fsPath));
    console.log(`${logTag} CMake configure`);
    await vscode.commands.executeCommand("cmake.configure");

    // Wait a moment for CMake to finish up (or we get "already running" errors).
    console.log(`${logTag} Waiting for CMake`);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log(`${logTag} CMake build`);
    await vscode.commands.executeCommand("cmake.build");
  } else {
    // No Cargo.toml and no CMakeLists.txt
    // Check for package.json with engines.vscode
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
      const fs = require("fs");
      const pkgPath = path.join(workspaceFolder, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = require(pkgPath);
        if (pkg.engines && pkg.engines.vscode) {
          vscode.window.showInformationMessage("Multi-Build: Detected VS Code extension project. Running npm install, packaging, and installing...");
          const terminal = vscode.window.createTerminal({ name: "Multi-Build Extension Install" });
          terminal.show();
          terminal.sendText("npm install");
          vscode.window.showInformationMessage("Multi-Build: Running npm install in terminal...");
          await new Promise((resolve) => setTimeout(resolve, 15000));
          terminal.sendText("npm run package");
          vscode.window.showInformationMessage("Multi-Build: Packaging extension in terminal...");
          // Wait for the new .vsix file to be created/updated
          const version = pkg.version;
          const vsixName = `multi-build-${version}.vsix`;
          const vsixPath = path.join(workspaceFolder, vsixName);
          let prevMtime = 0;
          if (fs.existsSync(vsixPath)) {
            prevMtime = fs.statSync(vsixPath).mtime.getTime();
          }
          const waitForVsix = async () => {
            for (let i = 0; i < 30; ++i) { // up to ~15 seconds
              if (fs.existsSync(vsixPath)) {
                const mtime = fs.statSync(vsixPath).mtime.getTime();
                if (mtime > prevMtime) {
                  return true;
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
            return false;
          };
          const found = await waitForVsix();
          if (!found) {
            vscode.window.showErrorMessage(`Multi-Build: ${vsixName} not found or not updated after packaging. Make sure packaging succeeded.`);
            return;
          }
          vscode.window.showInformationMessage(`Multi-Build: Installing extension from VSIX...`);
          await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          vscode.window.showInformationMessage(`Multi-Build: Installed and reloaded VS Code extension from ${vsixName}`);
          return;
        }
      }
    }
    vscode.window.showErrorMessage(`${extensionName}: No Cargo.toml, CMakeLists.txt, or VS Code extension (package.json with engines.vscode) found in the workspace.`);
  }
    } catch (error) {
    console.error(`${logTag} Error handling synced message:`, error);
    vscode.window.showErrorMessage(`${extensionName}: Error handling synced message: ${error}`);
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

    if (!output) {
      console.warn(`${cargoLogTag} No output from cargo-e, skipping target listing.`);
      return null;
    }

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
    // Sort targets alphabetically by label
    targetOptions.sort((a, b) => a.label.localeCompare(b.label));
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
    vscode.window.showInformationMessage(`${logTag} WebSocket connection opened`);
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
        //console.debug(`${logTag} Ack message received`);
      } else if (message.type === "error") {
        console.error(`${logTag} Error message received: ${message.message}`);
      } else if (message.type === "sync") {
        console.log(`${logTag} Sync message received:`, message.data);
        await handleSyncData(message.data);
      } else if (message.type === "update-and-install") {
        // Show notification when update/install message is received
        vscode.window.showInformationMessage("Multi-Build: Received update/install command from room. Running update...");
        // Only run update/install if this is the multi-build repo
        const pkg = require(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', "package.json"));
        if (pkg.name === "multi-build") {
          vscode.commands.executeCommand(updateAndInstallCommand);
        } else {
          vscode.window.showWarningMessage("Multi-Build: Ignored update/install command (not multi-build repo)");
        }
      } else if (message.type === "refresh-all-windows") {
        console.log(`${logTag} Received refresh-all-windows command.`);

        // Refresh the current window
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      } else if (message.type === "cargo-e") {
        const { manifestPath, target } = message.data;
        if (!manifestPath) {
          console.warn(`${cargoLogTag} No manifestPath provided in cargo-e message`);
          vscode.window.showErrorMessage(`${cargoLogTag} No manifestPath provided in cargo-e message`);
          return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder || !manifestPath) {
          vscode.window.showErrorMessage(`${cargoLogTag} Cannot run cargo-e: workspaceFolder or manifestPath is undefined.`);
          return;
        }
        // const posixManifestPath = manifestPath.split(path.sep).join(path.posix.sep);
        // const selectedDir = path.dirname(path.resolve(workspaceFolder, manifestPath));

        // console.log(`${cargoLogTag} Preparing to run 'cargo-e' in ${selectedDir}`);
        // const terminal = vscode.window.createTerminal({
        //   name: target ? `${target}` : "Cargo Build",
        //   cwd: selectedDir,
        // });
        // terminal.show();

        // const cargoCommand = target
        //   ? `cargo-e --manifest-path "${posixManifestPath}" --target ${target}`
        //   : `cargo-e --manifest-path "${posixManifestPath}"`;
        // console.log(`${cargoLogTag} Executing command: ${cargoCommand}`);
        // terminal.sendText(cargoCommand);
        if (workspaceFolder && manifestPath) {
          handleCargoECommand(manifestPath, target, workspaceFolder);
        } else {
          vscode.window.showErrorMessage(`${cargoLogTag} Cannot run cargo-e: workspaceFolder or manifestPath is undefined.`);
          console.error(`${cargoLogTag} Cannot run cargo-e: workspaceFolder or manifestPath is undefined.`);
        }
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

  try {
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
  } catch (error) {
    vscode.window.showErrorMessage(
      `${extensionName}: Error checking out or creating branch '${branchName}': ${error}`,
    );
    console.error(`${logTag} Error during branch checkout/create:`, error);
    return false;
  }

  console.log(`${logTag} Checked out branch '${branchName}' in repository ${repoName}`);
  vscode.window.showInformationMessage(
    `${extensionName}: Checked out branch '${branchName}' from '${repoName}' (remote: ${remoteName})`,
  );
  return true;
}

async function handleCargoE(data: { manifestPath: string; target?: string }) {
  const { manifestPath, target } = data;

  if (!manifestPath) {
    console.warn(`${cargoLogTag} No manifestPath provided in cargo-e message`);
    vscode.window.showErrorMessage(`${cargoLogTag} No manifestPath provided in cargo-e message`);
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    console.error(`${cargoLogTag} Workspace folder is undefined. Cannot run cargo-e.`);
    vscode.window.showErrorMessage(`${cargoLogTag} Cannot run cargo-e: workspaceFolder is undefined.`);
    return;
  }

  console.log(`${cargoLogTag} Resolved workspace folder: ${workspaceFolder}`);

  const posixManifestPath = manifestPath.split(path.sep).join(path.posix.sep);
  const selectedDir = path.dirname(path.resolve(workspaceFolder, manifestPath));

  console.log(`${cargoLogTag} Preparing to run 'cargo-e' in ${selectedDir}`);
  const terminal = vscode.window.createTerminal({
    name: target ? `${target}` : "Cargo Build",
    cwd: selectedDir,
  });
  terminal.show();

  const cargoCommand = target
    ? `cargo-e --manifest-path "${posixManifestPath}" --target ${target}`
    : `cargo-e --manifest-path "${posixManifestPath}"`;
  console.log(`${cargoLogTag} Executing command: ${cargoCommand}`);
  terminal.sendText(cargoCommand);
}

function handleCargoECommand(selectedFilePath: string, targetName: string | undefined, workspaceFolder: string) {
  try {
    if (!selectedFilePath || !workspaceFolder) {
      vscode.window.showErrorMessage(`${cargoLogTag} Cannot run cargo-e: missing manifest path or workspace folder.`);
      return;
    }

    const posixManifestPath = selectedFilePath.split(path.sep).join(path.posix.sep);
    const selectedDir = path.dirname(path.resolve(workspaceFolder, selectedFilePath));

    console.log(`${cargoLogTag} Preparing to run 'cargo-e' in ${selectedDir}`);
    const terminal = vscode.window.createTerminal({
      name: targetName ? `${targetName}` : "Cargo Build",
      cwd: selectedDir,
    });
    terminal.show();

    const cargoCommand = targetName
      ? `cargo-e --manifest-path "${posixManifestPath}" --target ${targetName}`
      : `cargo-e --manifest-path "${posixManifestPath}"`;
    console.log(`${cargoLogTag} Executing command: ${cargoCommand}`);
    terminal.sendText(cargoCommand);
  } catch (error) {
    vscode.window.showErrorMessage(`${cargoLogTag} Error running cargo-e: ${error}`);
    console.error(`${cargoLogTag} Error running cargo-e:`, error);
  }


        //      // Run cargo-e with the selected or received manifestPath and target
        // // Normalize to POSIX path for --manifest-path argument
        // const posixManifestPath = selectedFilePath.split(path.sep).join(path.posix.sep);
        // const selectedDir = path.dirname(path.resolve(workspaceFolder, selectedFilePath));
        // console.log(`${cargoLogTag} Preparing to run 'cargo-e' in ${selectedDir}`);
        
        // const terminal = vscode.window.createTerminal({
        //   name: targetName ? `${targetName}` : "Cargo Build",
        //   cwd: selectedDir,
        // });
        // terminal.show();
        
        // const cargoCommand = targetName ? `cargo-e --manifest-path "${posixManifestPath}" --target ${targetName}` : `cargo-e --manifest-path "${posixManifestPath}"`;
        // console.log(`${cargoLogTag} Executing command: ${cargoCommand}`);
        // terminal.sendText(cargoCommand);
}

