# deploy/

The production stack and the operator's commands. The runbook is [docs/DEPLOY.md](../docs/DEPLOY.md);
what every alert means is [docs/OPERATIONS.md](../docs/OPERATIONS.md). Every command reads the
repository-root `.env` (D-450) and is run from the repository root.

| Command                                 | What it does                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `deploy/generate-env.sh <host> <email>` | Writes the root `.env` with fresh secrets; refuses to overwrite without `--force` |
| `deploy/upgrade.sh`                     | Backs up, builds, migrates, switches and checks; the first deployment too         |
| `deploy/rollback.sh`                    | Puts the previous version back, with no build                                     |
| `deploy/restore.sh`                     | Lists, verifies or restores a backup                                              |
| `deploy/signin-link.sh <email>`         | Prints a one-time sign-in link when mail is broken                                |
| `deploy/dc <args>`                      | `docker compose` for this stack: the right file, env and version                  |

The rest is what those commands use:

- `compose.yml`, `Caddyfile`: the stack definition and the edge.
- `backup/`: the backup image (`backup.Dockerfile`) and its scripts, the restore drill, the backup key.
- `images/`: the ops-notify image. `ops/`: its script. `lib/`: shared shell code, grants, the RLS preflight.
- `sizes/`: resource presets for `generate-env.sh --size`. `observability/`: the optional Prometheus,
  Grafana and Tempo profile. `test/`: the offline tests of every script here (`deploy/test/run.sh`).
