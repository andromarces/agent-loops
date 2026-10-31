# Init with a task file

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before an init that passes `--task-file`, and before a later init in a session that already has an active run.

- `--task-file <path>` can replace `--task` on the init call, and the two cannot
  be combined. `--task-file -` reads the task from stdin, which also carries the
  prompt here. Stdin carries only one input, so pass `--prompt-file` for the
  prompt with `--task-file -`. Init refuses `--task-file -` without it.
  Stage that file before the first init call of the session, in the system
  temporary directory outside every work tree. No run of the session is active
  then, so the parent guard is not engaged. Write the file with the normal
  file-write tool of the harness. After that init, never write a file: the guard
  denies the file-edit tools of the parent for every path while any run of the
  session is active.
- A later init in the session, while another run is active, writes no file. Pass
  the task with `--task`, or with a `--task-file <path>` that was staged before
  the first init, and pass the prompt on stdin. Never use `--task-file -` there,
  because it needs a new `--prompt-file`.
