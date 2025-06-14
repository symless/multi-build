# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.6] - 2025-06-12

- Add command to show/edit room ID
- Auto-detect cargo and cmake projects on sync, add cargo-e target selection

## [0.0.5] - 2025-05-14

- Pre-select current repository and remote in selection lists

## [0.0.4] - 2025-05-14

- Selection of different repos and remotes
- Update README.md - Add instructions

## [0.0.3] - 2025-05-14

- Add WebSocket support for syncing
- Only build when checkout OK

## [0.0.2] - 2025-05-14

- Save config to `settings.json` instead of `.json` file in root of project and rely on VS Code to sync the data.

## [0.0.1] - 2025-05-05

- Initial release
- First prototype, uses `.json` in the root of each project which needs to be sync'd manually with something like [Syncthing](https://syncthing.net/).
