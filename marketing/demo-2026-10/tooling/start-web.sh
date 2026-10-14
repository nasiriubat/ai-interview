#!/bin/bash
export AUTH_SECRET=$(node -p "require('/private/tmp/claude-504/d/demo-state.json').authSecret")
export API_URL=http://127.0.0.1:4110 AUTH_TRUST_HOST=true EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=demo@localhost NEXTAUTH_URL=http://localhost:3200 NEXT_PUBLIC_CONTACT_EMAIL=hello@example.com
cd /Users/mhnash/Desktop/projects/ai-interview/.claude/worktrees/agent-a0d17a8667c5ce565/apps/web
exec pnpm exec next start -p 3200
