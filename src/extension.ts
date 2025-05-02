import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { API as GitAPI, Repository, GitExtension } from "../typings/git";

const logTag = "[multi-host-build]";
const configFileName = "multi-host-build.json";

interface BuildCommand {
  repo: string;
  remote: string;
  branch: string;
}

export function activate(context: vscode.ExtensionContext) {
  console.log(`${logTag} Extension is active`);

  const startCommand = "multiHostCmake.startWatcher";
  console.log(`${logTag} Registering command: ${startCommand}`);
  const disposable = vscode.commands.registerCommand(startCommand, () => {
    startWatcher();
  });
  context.subscriptions.push(disposable);

  startWatcher();
}

export function deactivate() {}

function startWatcher() {
  console.log(`${logTag} Starting watcher`);

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage("No workspace open");
    return;
  }

  const configFile = path.join(workspaceFolders[0].uri.fsPath, configFileName);
  if (!fs.existsSync(configFile)) {
    vscode.window.showErrorMessage(`File not found: ${configFile}`);
    return;
  }

  console.log(`${logTag} Config file: ${configFile}`);

  console.log(`${logTag} Initial process`);
  processFile(configFile);

  console.log(`${logTag} Watching for changes`);
  fs.watchFile(configFile, { interval: 1000 }, async () => processFile(configFile));
}

async function processFile(filePath: string) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(content) as BuildCommand;

    try {
      await checkoutBranch(data.repo, data.remote, data.branch);
      vscode.window.showInformationMessage(`Checked out: ${data.branch}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to checkout: ${err}`);
      return;
    }

    console.log(`${logTag} CMake configure`);
    await vscode.commands.executeCommand("cmake.configure");

    // HACK: Need to find a better way to wait for CMake to finish.
    console.log(`${logTag} Waiting for CMake`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log(`${logTag} CMake build`);
    await vscode.commands.executeCommand("cmake.build");
  } catch (err) {
    console.error(`${logTag} Watcher error:`, err);
  }
}

async function checkoutBranch(repoName: string, remoteName: string, branchName: string) {
  console.log(`${logTag} Checking out branch ${branchName} in repository ${repoName}`);

  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
  const git: GitAPI | undefined = gitExtension?.getAPI(1);

  if (!git || git.repositories.length === 0) {
    vscode.window.showErrorMessage("No Git repository found.");
    return;
  }

  const repo = git.repositories.find((r) => path.basename(r.rootUri.fsPath) === repoName);
  if (!repo) {
    vscode.window.showErrorMessage(`Repository ${repoName} not found.`);
    return;
  }

  console.log(`${logTag} Found repository: ${repo.rootUri.fsPath}`);

  const ref = `${remoteName}/${branchName}`;
  await repo.fetch(remoteName, branchName);

  if (repo.getBranch(branchName) !== undefined) {
    console.log(`${logTag} Branch ${branchName} already exists`);
    await repo.checkout(branchName);
    return;
  }

  console.log(`${logTag} Branch ${branchName} does not exist, creating new branch`);
  await repo.checkout(ref);
  await repo.createBranch(branchName, true, ref);
  await repo.setBranchUpstream(branchName, ref);

  console.log(`${logTag} Checked out branch ${branchName} in repository ${repoName}`);
}
