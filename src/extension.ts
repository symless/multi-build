import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

interface BuildCommand {
  command: string;
  branch: string;
  timestamp: number;
}

let lastTimestamp = 0;

export function activate(context: vscode.ExtensionContext) {
  const command = "multiHostCmake.startWatcher";
  const disposable = vscode.commands.registerCommand(command, () => {
    vscode.window.showInformationMessage("Multi-Host Watcher Started");

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage("No workspace open");
      return;
    }

    const watchPath = path.join(workspaceFolders[0].uri.fsPath, "build-command.json");

    fs.watchFile(watchPath, { interval: 1000 }, async () => {
      try {
        const content = fs.readFileSync(watchPath, "utf8");
        const data = JSON.parse(content) as BuildCommand;

        if (data.timestamp > lastTimestamp && data.command === "build") {
          lastTimestamp = data.timestamp;

          vscode.window.showInformationMessage(`Running build for branch: ${data.branch}`);

          await vscode.commands.executeCommand("git.checkout", data.branch);
          await vscode.commands.executeCommand("cmake.configure");
          await vscode.commands.executeCommand("cmake.build");
        }
      } catch (err) {
        console.error("Watcher error:", err);
      }
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
