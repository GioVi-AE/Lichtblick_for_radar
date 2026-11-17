# Changes to upstream Lichtblick files

Baseline: `lichtblick-suite/lichtblick` v1.31.0 (tag `v1.31.0`, remote `upstream`).
Everything else in this fork is new files. These edits are intentionally tiny to keep upstream merges trivial
(`git fetch upstream && git merge upstream/<tag>`); modified files remain MPL-2.0.

| File | Change |
| --- | --- |
| `packages/suite-web/src/WebRoot.tsx` | Import `BuiltinExtensionLoader` and append it to `defaultExtensionLoaders` (marked `RADAR-FORK`) |
| `packages/suite-web/src/webpackConfigs.ts` | HTML title `Lichtblick` → `Eagle Radar Analysis` |
| `.dockerignore` | Also ignore `.git/`, `services/`, `data/`, extension `node_modules`/`dist`, `__pycache__` |
| `.github/workflows/*` | Upstream workflows moved to `.github/upstream-workflows/` (disabled; they need upstream secrets). `radar-ci.yml` added |
| `README.md` | Upstream README moved to `README.upstream.md`; new README |

New (proprietary) files that integrate with upstream: `packages/suite-web/src/services/BuiltinExtensionLoader.ts`.

## Upgrading upstream
1. `git fetch upstream --tags && git merge <tag>`; conflicts can only occur in the files listed above.
2. `docker compose build web` — the ext-build stage compiles the extension against its own typings
   (`extensions/eagle-radar/src/lichtblick.ts`), so API drift shows up as a build/test failure there.
3. Re-run the acceptance checks in `docs/radar/operations.md`.
