---
name: external-subagents
description: "Use when the user explicitly asks to invoke another coding agent CLI as a subagent. Triggers include phrases like 'get a second opinion from Codex', 'have Gemini review this', 'run this through Claude Code', 'ask another agent', or 'use a different model for this'. Supports Claude Code, Codex CLI, and Gemini CLI. Never invoke autonomously."
compatibility: "Requires shell/command execution access. The agent must be able to run CLI commands. If the agent is sandboxed, it must have a mechanism to execute commands outside the sandbox."
---

# External Subagents

## Overview

This skill teaches agents how to invoke other coding agent CLIs (Claude Code, Codex CLI, Gemini CLI) as external subagents when the user explicitly requests it. The core principle is that different models provide different perspectives -- a second opinion from a different model can catch issues, suggest alternatives, or validate approaches that a single model might miss.

## When to Use

**Only invoke an external subagent when the user explicitly asks.** Look for phrases like:

- "Get a second opinion from Codex"
- "Have Gemini review this"
- "Run this through Claude Code"
- "Ask another agent to look at this"
- "Use a different model to analyze this"
- "Get Codex/Gemini/Claude to do X"

**Do NOT use this skill when:**

- The user has not asked for an external agent -- never invoke autonomously
- The task is something you can do yourself and the user has not requested delegation
- The user asks you to "think harder" or "try again" -- that is about your own reasoning, not delegation
- No supported CLI is installed on the system
- You are already the agent mentioned by the user. For example, if you are Claude Code, and the user requested to perform review using claude, you should use your own Task tool to create subagents instead of invoking another Claude instance using Bash. If you are Claude Code or Claude, you MUST not launch `claude`. If you are Codex or Codex CLI, you MUST not launch `codex`. If you are Gemini or Gemini CLI, you MUST not launch `gemini`.

## Core Flow

1. **Detect available CLIs.** Run `which claude codex gemini` (or check each individually) to see which agent CLIs are installed. Each line of output corresponds to a found binary. If none are found, inform the user and stop. This command must be ran on host, running inside sandbox will not work.

2. **Select the tool.** If the user specified which agent to use, use that one. If they said something generic like "get a second opinion", suggest from the available CLIs and confirm with the user, or pick one if only one is available.

3. **Check sandbox status.** Determine if you are running in a sandbox. If so, you will need to escape the sandbox for the invocation command (see Sandbox Escape below). The subagent itself still runs sandboxed.

4. **Build the command.** Construct the CLI invocation with:
   - The task as the prompt (include relevant file paths and context)
   - Flags for non-interactive, sandboxed execution with full permissions
   - The current working directory so the subagent operates on the same project
   - Any skill or context file paths the subagent should read (see Passing Context below)

5. **Execute.** Run the command in the background if your tooling supports it (see Background Execution). Otherwise, run in the foreground and wait for completion.

6. **Report results.** Present the subagent's stdout output to the user. Summarize key findings if the output is long.

## Command Templates

### Claude Code

```bash
claude --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true}}' \
  -p "Your task description here."
```

### Codex CLI

```bash
codex exec --full-auto "Your task description here."
```

### Gemini CLI

```bash
gemini -p "Your task description here." \
  --approval-mode yolo --sandbox
```

**Notes:**

- All three CLIs output plain text to stdout by default.
- No `--model` flag is included -- let each CLI use its default model.
- The prompt string should contain the full task description, relevant file paths, and any instructions for the subagent.
- See the reference files for additional flags and options.

## Sandbox Escape

If the parent agent (you) is running in a sandbox, the subagent CLI binary may not be accessible or allowed to execute inside that sandbox. You must escape the sandbox **for the invocation only** -- the subagent itself still runs in its own sandbox with full permissions.

**Per-agent mechanisms:**

- **Claude Code as parent:** Set `dangerouslyDisableSandbox: true` on the Bash tool call that runs the subagent command. This lets the invocation run on the host. The subagent CLI then manages its own sandbox independently.

- **Other agents as parent:** Use your agent's equivalent sandbox-bypass mechanism for the invocation command only. The `--settings` sandbox flag (Claude Code), `--full-auto` flag (Codex), and `--sandbox` flag (Gemini) ensure the subagent itself runs sandboxed regardless.

**Key principle:** Only the invocation escapes the parent's sandbox. The subagent process runs with its own sandboxing and permission model.

## Passing Context and Skills

Enrich the subagent's prompt with relevant context so it can do useful work:

- **Skill files:** Tell the subagent to read skill files by including absolute paths in the prompt text. Do not use system prompt flags -- put instructions directly in the prompt.

- **Working directory:** Run the subagent command from the same working directory as the parent agent so it has access to the same project files.

- **Specific files:** Mention specific files the subagent should look at rather than expecting it to discover them on its own.

**Example prompt with skill and file references:**

```bash
claude --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true}}' \
  -p "Review the authentication logic in /home/user/project/src/auth.py \
for security vulnerabilities. Before starting, read the skill file at \
/home/user/.claude/skills/security-review/SKILL.md and follow its guidelines. \
Focus on input validation and session management."
```

## Background Execution

Run the subagent in the background when your tooling supports it. This lets you run multiple subagents in parallel or continue other work while waiting.

- **Claude Code:** Use the `run_in_background` parameter on the Bash tool call. You will be notified when the command completes.

- **Codex CLI / Gemini CLI:** If your agent does not have a native background execution mechanism, redirect output to a temporary file and run in the background (e.g., `codex exec --full-auto "task" > /tmp/subagent-output.txt 2>&1 &`), then use `wait` and read the file when done. Alternatively, simply run in the foreground.

**Parallel execution example:** You can invoke two different agents simultaneously to get independent perspectives, then compare their outputs when both complete.

## Reference

For detailed flags, options, and additional examples for each CLI tool:

- See [Claude Code reference](references/claude-code.md) for detailed flags.
- See [Codex CLI reference](references/codex-cli.md) for detailed flags.
- See [Gemini CLI reference](references/gemini-cli.md) for detailed flags.
