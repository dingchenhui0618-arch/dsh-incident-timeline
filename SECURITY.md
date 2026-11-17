# Security

## Scope

`dsh-incident-timeline` reads DeepSeek Harness session logs and writes only its
own projection database. It does not execute session content, make network
requests, install dependencies, or modify session files.

## Read-only guarantee

- Session discovery uses `readdir` / `lstat`; scanning uses `readFile` only.
- The only writes are to `<dataDir>/projection.db` (and SQLite's `-wal`/`-shm`
  sidecars) and, for the CLI, the explicit `--out` file.
- `test/project.test.mjs` asserts that session SHA-256, mtime and directory
  entries are unchanged across a forced resync.

## Sensitive data

Session logs may contain prompts, tool output, file paths, customer data or
credentials. The exporter intentionally copies excerpts into Markdown/JSON so
that incidents remain citable. Treat generated reports with the same care as
the session logs themselves, and review before sharing.

The tool never reads `~/.dsh/.credentials.yaml`, `auth.json`, plugin profile
configuration, or any path outside the configured sessions root.

## HTTP surface

The host route is registered on the local DSH web server under
`/dsh-incident-timeline`. It is read-only except `POST /sync`, which only
rescans the sessions root. No authentication is added: it inherits the host's
local-only web server boundary.

## Resource limits

- Default maximum compressed session size: 64 MiB (`--max-session-mb`).
- Default decoded cap: 128 MiB; exceeding it marks the projection incomplete
  rather than pretending it is whole.
- Export lists are capped at 5000 events; counts remain over the whole window.

## Reporting

Open a private security advisory on GitHub, or contact the maintainer listed in
the repository profile. Please include the DSH version, plugin version, and a
minimal reproduction (a synthetic session log is enough; do not paste real
credentials).
