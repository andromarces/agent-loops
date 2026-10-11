Before the init dispatch call, run `__AGENT_LOOP_CLI__ harness-check {{HARNESS_ID}}`. It
exits 0 only when the nearest harness process above this shell is {{HARNESS_LABEL}}. If
it exits 3, stop and report that another harness owns the session; do not start a run.
If it exits with any other non-zero code, stop and report that the check could not run or
found no harness ancestor, which is distinct from a harness refusal. Do not use
`{{SESSION_VAR}}` to make this decision, because {{SESSION_VAR_REASON}}.
