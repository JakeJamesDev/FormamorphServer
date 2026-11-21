# 02: Correct the Supporter download changelog line

Status: ready-for-agent
Blocked by: 01
Recommended model: Claude Haiku 5.5 (`claude-haiku-5-5`)
Reasoning effort: low

Repo: formamorph. One changelog entry, written as a fragment from the ticket worktree.

## What to build

The changelog tells players the real fix. The In Progress entry from `2d66c416f` says large Supporter worlds now download on slow connections. That names the wrong cause. Spec ruling R5.

## Acceptance criteria

- [ ] The entry is replaced with one that states the outcome: large Supporter-only worlds such as Sunmeadow Town now download from Community Creations. The lead stands alone and follows the changelog lead rules.
- [ ] The client idle-timeout code from `2d66c416f` is untouched.
