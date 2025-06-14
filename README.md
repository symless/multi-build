# Multi-Build

VS Code extension to switch all machines to the same branch, configure, and build.

This extension is easier to use if you [synchronize](https://code.visualstudio.com/docs/configure/settings-sync)
your `settings.json` file across all of your computers.

> [!TIP]
> Currently, only Git and CMake are supported _for now_.
> Please open a feature request issue if you want support for other tools, custom commands, etc.

![Leeloo Dallas Multi-Build](https://github.com/user-attachments/assets/ae110ac8-959e-4a75-872d-be80bc079b6a)

## Contributing

Thanks for your interest in contributing!

Please see the [Contributing](https://github.com/symless/multi-build/wiki/Contributing) article on our wiki.

Happy coding.

## Download & Install

1. Download the [latest release](https://github.com/symless/multi-build/releases)
2. Open VS Code
3. Go to 'Extensions'
4. Click the 3-dots menu
5. Ciick 'Install from VSIX'
6. Open the downloaded .vsix file

## How to use

**Prerequisites:**
- The extension should automatically create an entry in `settings.json`, `multiBuild.server.roomId`, and if you
  have your VS Code setup to sync your settings, this room ID will automatically be shared on all your computers.
  You may need to force-sync as VS Code can have a mind of its own.
- When the extension loads, it'll ask you to sign in to GitHub, which securely synchronizes data between each
  computer over the Internet (this is done via WebSockets).

**Steps:**
1. Press F1
3. Find 'Multi-Build: Sync'
4. Enter your repo, remote, and branch name

If you did it right, all computers checkout the same branch, configure, and build.

## FAQ

### What problem does this solve?

If you develop on multiple computers and need to test a PR, you have likely found yourself getting tired of doing 
the following on each computer: checkout a branch, pull changes, configure, and build. Doing this on two computers
isn't _too_ much of a chore, but what if you have three, four, or more? Then it starts to get really tedious.

Multi-Build makes it possible to test a PR on multiple computers with a single command.

### Any plans to go on the marketplace?

Yes, when we get enough requests. Right now you have to manually install the `.vsix` which isn't too hard.

### How does it work?

We run a WebSockets server that your computers will connect to securely via a GitHub auth token.
When you run the sync command, all computers will receive it along with what repo, remote, and branch to checkout and pull.
Once checkout is done, the configure and build commands run so that all computers have build the same version.
