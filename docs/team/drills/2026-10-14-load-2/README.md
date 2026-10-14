# Load run output, second drill, 2026-10-14

`summary.json` is k6's `--summary-export`, `run.txt` the version, the number of campaign links the
run used (`links`) and the fake provider's behaviour, `peaks.txt` the peak memory and CPU per
container from `docker stats` (5 s samples). All runs are against the **default** abuse limits of
the version named in `run.txt`. The first run's directory is named for its time; the record that
explains it is [2026-10-14-full-stack-2.md](../2026-10-14-full-stack-2.md).

| Directory                    | Version        | What it is                                                                                                            | Result                                                             |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `full-20261014T115147Z`      | `c09d7bd7b952` | Full run; the harness sent the whole burst to one campaign (an `__ITER` fault, D-315). Limits 120 an hour, 500 tenant | 311 of 499 open attempts refused (429), 88 voice sessions refused  |
| `full-20261014T120248Z`      | `c09d7bd7b952` | Full run, arrivals spread over three campaigns, same limits                                                           | 0 refused of 277 opens; per campaign 113, 85, 79 of 120            |
| `office-20261014T115738Z`    | `c09d7bd7b952` | 40 people behind one address in 2 minutes, per-address bucket 30 a minute                                             | 0 refused                                                          |
| `office-20261014T120010Z`    | `c09d7bd7b952` | 60 people behind one address in 1 minute, bucket 30                                                                   | 3 people (6 requests) refused                                      |
| `office-20261014T120126Z`    | `c09d7bd7b952` | 90 people behind one address in 1 minute, bucket 30                                                                   | 60 of 90 refused (30 through)                                      |
| `office-20261014T120902Z`    | `59e30a812e31` | The same 90 people, bucket 120 (D-310)                                                                                | 0 refused                                                          |
| `full-20261014T121143Z`      | `59e30a812e31` | Full run with every arrival on ONE campaign (`LINKS=1`), limits 300 an hour, 1000 tenant (D-311)                      | 0 refused of 279 opens; 0 errors, 0 5xx; first token p95 519 ms    |
| `single-ip-20261014T121650Z` | `59e30a812e31` | 200 opens from one address (the negative control)                                                                     | 120 accepted, 80 refused: the limiter still cuts one client at 120 |

Reproduce: `deploy/drill/stack.sh up && deploy/drill/stack.sh configure && load/run.sh full`
(`LINKS=1` for one campaign; `OFFICE_PEOPLE=90 OFFICE_MINUTES=1 load/run.sh office`;
docs/DEPLOY.md, "Capacity and load").
