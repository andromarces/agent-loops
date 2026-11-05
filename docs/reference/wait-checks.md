# `wait-checks`

Part of [Child dispatch](role.md). The orchestrator rules for the command are in [Waiting for required checks](../orchestrator/waiting-for-checks.md), which also holds the retry, paging, and `Link` host rules of its reads.

Usage: `agent-loop role wait-checks --pr <pr> [--all [--expect <check name>]...] [--head <sha>] [--cwd <dir>] [--timeout <seconds>]`. It prints `{"status": "ok", "pr": 42, "timedOut": false, "head": "<sha>", "checks": [{"name": "ci", "state": "SUCCESS", "bucket": "pass"}]}`.

The [command detail](../orchestrator/waiting-for-checks.md#command-detail) holds each rule that this page previously restated.

`--cwd` must be inside a Git work tree, as it is for `dispatch`.
