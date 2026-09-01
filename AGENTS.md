# AGENTS.md — Project Instructions for Coding Agents

This repository runs **Superpowers** (obra/superpowers v6.3.0, vendored under
`.claude/plugins/superpowers/`). Superpowers is a mandatory methodology: a set
of composable skills plus this bootstrap that makes agents invoke them.

## The Rule (non-negotiable)

**Invoke relevant or requested skills BEFORE any response or action** —
including clarifying questions, exploring the codebase, or checking files. If
it turns out wrong for the situation, you don't have to use it.

- Before any "let's build X" work: use the **brainstorming** skill first.
- Before fixing a bug: use the **systematic-debugging** skill first.
- Process skills come first (they set the approach), then implementation
  skills carry it out.

Workflow: announce **"Using `<skill>` to `<purpose>`"**, then read the skill's
`SKILL.md` (paths below) and follow it exactly. If it has a checklist, create a
todo per item.

## The Standard Workflow

1. **brainstorming** — refine the idea into a written spec/design, validated
   in sections with the user before any code.
2. **using-git-worktrees** (optional) — isolated branch for the work.
3. **writing-plans** — turn the approved design into bite-sized tasks with
   exact file paths, code, and verification steps.
4. **test-driven-development** — RED→GREEN→REFACTOR: failing test first, watch
   it fail, minimal code, watch it pass.
5. **executing-plans / subagent-driven-development** — implement per plan,
   task by task, with review checkpoints.
6. **requesting-code-review** — review against the plan between tasks.
7. **finishing-a-development-branch** — verify, merge/PR when done.

## Skills Index

Read the full `SKILL.md` for any skill that applies — they live at
`.claude/plugins/superpowers/skills/<name>/SKILL.md`.

| Skill | When to use | Purpose |
|---|---|---|
| `using-superpowers` | every session start | how to find/use skills (this bootstrap) |
| `brainstorming` | any new feature/build request | Socratic design refinement → spec document |
| `writing-plans` | design approved, before coding | detailed task-level implementation plan |
| `executing-plans` | plan exists | batch execution with human checkpoints |
| `subagent-driven-development` | plan exists, speed matters | fresh subagent per task + two-stage review |
| `test-driven-development` | during implementation | RED-GREEN-REFACTOR, tests before code |
| `systematic-debugging` | any bug/failure | 4-phase root cause process |
| `verification-before-completion` | before declaring done / "it's fixed" | prove the fix actually works |
| `requesting-code-review` | between tasks | review against plan, severity-ranked issues |
| `receiving-code-review` | review feedback received | responding to review feedback |
| `using-git-worktrees` | design approved, parallel work | isolated workspace on a new branch |
| `finishing-a-development-branch` | tasks complete | verify + merge/PR/discard decision |
| `dispatching-parallel-agents` | independent subtasks | concurrent subagent workflows |
| `writing-skills` | creating/modifying skills | author skills following best practices |

## Red Flags — Stop and re-check for a skill

Questions are tasks. "Let me explore first" is not a reason to skip the skill
check. Skills tell you HOW to explore. If a skill exists for the situation,
use it — "it's overkill" / "I remember it" (skills evolve; read the current
version) are rationalizations. User instructions take precedence over skills;
only skip a workflow when your human partner explicitly tells you to.