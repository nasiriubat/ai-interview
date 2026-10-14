#!/bin/bash
export LIVE_API_PORT=4110 DEMO_STATE=/private/tmp/claude-504/d/demo-state.json
cd /Users/mhnash/Desktop/projects/ai-interview/.claude/worktrees/agent-a0d17a8667c5ce565/scripts/live-run
exec pnpm exec tsx src/demo-requirements.ts
