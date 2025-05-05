# multi-host-build README

Switch all machines to the same Git branch and build.

This is a simple prototype which requires a `multi-host-build.json` file to be syncronized at the root of your project on each computer (e.g. using Syncthing).

In the future, if developed further, this extension may be improved to:
- Sync without needing to manage a `multi-host-build.json` file (e.g. use VS Code settings sync)
- Sync automatically when changing a branch on one computer
