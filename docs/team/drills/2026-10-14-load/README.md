# Load run output, 2026-10-14

`summary.json` is k6's `--summary-export`, `run.txt` the version and the fake provider's behaviour
at the time, `peaks.txt` the peak memory and CPU per container from `docker stats` (5 s samples).

| Directory                    | What it is                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `full-20261014T081249Z`      | The full run (40 interviews, 5 voice, 100-open burst, admin), default limits, version `ffd17ea6ce11` |
| `full-20261014T090021Z`      | The same run under the 4 GB limits (`deploy/sizes/4gb.env`), version `b44a1b30a66e`                  |
| `full-20261014T081855Z`      | Voice only, provider with no latency: the platform's own overhead (first word p95 90 ms)             |
| `full-20261014T082243Z`      | Voice only, provider at 250 characters a second: first word p95 1.76 s                               |
| `single-ip-20261014T075837Z` | 60 opens from one address: 30 accepted, 30 rate limited                                              |

Reproduce: `deploy/drill/stack.sh up && deploy/drill/stack.sh configure && load/run.sh full`
(docs/DEPLOY.md, "Capacity and load").
