import * as path from "path";
import * as vscode from "vscode";
import { API as GitAPI, GitExtension } from "../typings/git";

const extensionName = "Multi-Build";
const logTag = "[multi-build]";
const configKey = "multiBuild";
const startCommand = `multiBuild.start`;
const stopCommand = `multiBuild.stop`;
const pushCommand = `multiBuild.push`;

var configWatcher: vscode.Disposable | undefined;
var workspaceWatcher: vscode.Disposable | undefined;

interface PushArgs {
  repo: string;
  remote: string;
  branch: string;
}

export function activate(context: vscode.ExtensionContext) {
  console.log(`${logTag} Activating extension`);

  console.log(`${logTag} Registering command: ${startCommand}`);
  const disposable = vscode.commands.registerCommand(startCommand, () => {
    try {
      startWatchers();
    } catch (error) {
      handleError(error);
    }
  });
  context.subscriptions.push(disposable);

  console.log(`${logTag} Registering command: ${stopCommand}`);
  const stopDisposable = vscode.commands.registerCommand(stopCommand, () => {
    try {
      stopWatchers();
    } catch (error) {
      handleError(error);
    }
  });
  context.subscriptions.push(stopDisposable);

  console.log(`${logTag} Registering command: ${pushCommand}`);
  const pushDisposable = vscode.commands.registerCommand(pushCommand, async () => {
    try {
      await pushRepoSettings();
    } catch (error) {
      handleError(error);
    }
  });
  context.subscriptions.push(pushDisposable);

  try {
    startWatchers();
  } catch (error) {
    handleError(error);
  }
}

export function deactivate() {
  try {
    stopWatchers();
  } catch (error) {
    handleError(error);
  }
}

function handleError(error: unknown) {
  if (error instanceof Error) {
    console.error(`${logTag} Error: ${error.message}`);
    vscode.window.showErrorMessage(`${extensionName}: ${error.message}`);
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

  console.log(`${logTag} Processing config first time`);
  processConfig();

  console.log(`${logTag} Watching for config changes`);
  configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(configKey)) {
      console.log(`${logTag} Config changed for key: ${configKey}`);
      try {
        processConfig();
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
        processConfig();
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

async function pushRepoSettings() {
  const config = getConfig();

  const repo = await vscode.window.showInputBox({
    prompt: "Enter the repository name",
    placeHolder: "hello-repo",
    value: config?.repo,
  });
  if (!repo) {
    vscode.window.showErrorMessage(`${extensionName}: No repo provided`);
    return;
  }

  const remote = await vscode.window.showInputBox({
    prompt: "Enter the remote name",
    placeHolder: "hello-remote",
    value: config?.remote || "origin",
  });
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

  console.log(`${logTag} Pushing changes to config`);
  await vscode.workspace.getConfiguration().update(configKey, { repo, remote, branch }, true);
}

function getConfig() {
  const config = vscode.workspace.getConfiguration(configKey);
  const repo = config.get<string>("repo");
  const remote = config.get<string>("remote");
  const branch = config.get<string>("branch");

  if (!repo || !remote || !branch) {
    return null;
  }

  return { repo, remote, branch };
}

async function processConfig() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    console.log(`${logTag} No workspace folders found, skipping`);
    return;
  }

  const config = getConfig();
  if (!config) {
    console.log(`${logTag} No config found, skipping`);
    return;
  }

  console.log(`${logTag} Processing config:`, config);
  const { repo, remote, branch } = config;

  await checkoutBranch(repo, remote, branch);
  vscode.window.showInformationMessage(`${extensionName}: Checked out: ${branch}`);

  console.log(`${logTag} CMake configure`);
  await vscode.commands.executeCommand("cmake.configure");

  // Wait a moment for CMake to finish up (or we get "already running" errors).
  console.log(`${logTag} Waiting for CMake`);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(`${logTag} CMake build`);
  await vscode.commands.executeCommand("cmake.build");
}

async function checkoutBranch(repoName: string, remoteName: string, branchName: string) {
  console.log(`${logTag} Checking out branch ${branchName} in repository ${repoName}`);

  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
  const git: GitAPI | undefined = gitExtension?.getAPI(1);

  if (!git || git.repositories.length === 0) {
    vscode.window.showErrorMessage(`${extensionName}: No Git repository found.`);
    return;
  }

  const repo = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repoName);
  if (!repo) {
    vscode.window.showErrorMessage(`${extensionName}: Repository ${repoName} not found.`);
    return;
  }

  console.log(`${logTag} Found repository: ${repo.rootUri.fsPath}`);

  const ref = `${remoteName}/${branchName}`;
  await repo.fetch(remoteName, branchName);

  if (repo.getBranch(branchName) !== undefined) {
    console.log(`${logTag} Branch ${branchName} already exists`);
    await repo.checkout(branchName);
    await repo.pull();
    return;
  }

  console.log(`${logTag} Branch ${branchName} does not exist, creating new branch`);
  await repo.checkout(ref);
  await repo.createBranch(branchName, true, ref);
  await repo.setBranchUpstream(branchName, ref);

  console.log(`${logTag} Checked out branch ${branchName} in repository ${repoName}`);
}
