# 0129. Map ssh.github.com to github.com for the worker PR declaration

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0043: Let the headless runtime declare the PR that a worker opens](0043-let-the-headless-runtime-declare-the-pr-a-worker-opens.md). The replaced part is decision 6's comparison of the SSH remote host with the PR URL host as one literal string. The comparison maps the exact SSH host `ssh.github.com` to `github.com` first. Every other part of decision 6 stays in force. The owner and repository must still match, and every other host keeps its own identity.

## Date

2026-11-12

## Context

GitHub documents `ssh.github.com` on port 443 as its SSH host for networks that block port 22. An SSH alias with `HostName ssh.github.com` resolves to that host. A literal `ssh://git@ssh.github.com:443/owner/repo.git` remote names it too. The pull request URL names `github.com`. ADR 0043 decision 6 compared the two hosts as one literal string. The identities then differed, so the runtime declared no pull request (issue #1888). PR #1882 resolved the SSH alias through `ssh -G` and kept the `hostname` value. Its review deferred this mapping.

## Decision

1. **One mapping.** After the SSH host resolution, `repoIdentity` maps the exact host `ssh.github.com` to `github.com`. It does this once, for the remote identity only.
2. **SSH only.** The mapping applies to an SSH remote in the scp and `ssh:` forms. It covers a literal host and a host resolved through `ssh -G`. `URL.hostname` drops a port such as `:443` before the mapping.
3. **Exact host.** The comparison is case-insensitive and matches the whole host. `ssh.github.example.com`, `ssh.ghe.example.com`, `github.example.com`, `ssh.github.com.example.com`, and `foo.ssh.github.com` keep their own identity.
4. **Other forms.** An `https:`, `http:`, or `git:` remote keeps its host. The PR URL keeps its host in every case.
5. **Failure.** A failed `ssh -G` read keeps the literal host, as ADR 0043 requires. The mapping then applies to that literal host.

## Consequences

- An SSH remote on `ssh.github.com` matches a PR on `github.com`, and the runtime declares it.
- A GitHub Enterprise host keeps its identity. The change adds no mapping for another host.
- A remote on `ssh.github.com` still refuses a PR in another owner or repository.
- The stored identity for `ssh.github.com` is `github.com/owner/repo`.

## Alternatives

1. **Map every `ssh.` prefix or every `github.com` subdomain to `github.com`.** Rejected. `ssh.ghe.example.com` and `foo.ssh.github.com` name other hosts.
2. **Accept the PR URL host when the `ssh -G` output contains `github.com`.** Rejected. A substring test maps `ssh.github.com.example.com` too.
3. **Tell the operator to use a `HostName github.com` alias.** Rejected. A literal `ssh://git@ssh.github.com:443/...` remote has no alias to change.

## Authors

Andro Marces

## Links

- [Issue #1888](https://github.com/andromarces/agent-loops/issues/1888)
- Partially supersedes [ADR 0043](0043-let-the-headless-runtime-declare-the-pr-a-worker-opens.md)
- [PR #1882](https://github.com/andromarces/agent-loops/pull/1882)
- Implementation:
  - Source: `repoIdentity` in `src/lib/worker-pr.mjs`
  - Tests: `tests/lib/worker-pr.test.mjs`
- [ADR Index](README.md)
