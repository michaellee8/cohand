---
name: full-spectrem-review
description: Perform a full spectrem review of the codebase, and then compile them into a report.
disable-model-invocation: true
---


launch multiple subagents, as well as multiple codex instances in the background, to perform a full spectrem of review on different aspects of this codebase, like security, code quality, bugs and etc, 1 claude subagent and 1 codex instance for each aspect. Each of them should output their findings to a temporary location. After that, launch another subagent to read all the finding files, and compile them into a review report under docs/review-reports/REVIEWR_REPORT_{YYYYMMDD}_{hhmmss}.md. datetime should be in UTC form.

