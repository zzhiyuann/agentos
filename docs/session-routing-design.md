# Session Routing & Lifecycle Design

## Problem

Current model: 1 issue → 1 isolated CC session → 1 workspace.
Real-world: agents operate like team members — they work across issues
within a project, maintain context, and respond to multiple trigger types.

## Trigger Types

| Trigger | Linear Event | Expected Behavior |
|---------|-------------|-------------------|
| @AgentOS in comment | AgentSessionEvent `created` | Start work on this issue |
| Issue delegated to AgentOS | AgentSessionEvent `created` | Start work on this issue |
| Issue assigned to AgentOS | Issue webhook (assignee change) | Queue or start work |
| Issue moved to "Todo" with agent label | Issue webhook (state change) | Auto-start |
| Follow-up message in session | AgentSessionEvent `prompted` | Continue in same session |
| Stop signal | AgentSessionEvent `prompted` (signal=stop) | Gracefully stop |

## Session Scope: Issue vs Project vs Repo

### Option A: Issue-scoped (current)
```
Issue ENG-7 → CC Session A (workspace: ~/agent-workspaces/ENG-7/)
Issue ENG-8 → CC Session B (workspace: ~/agent-workspaces/ENG-8/)
```
- Pro: Simple, isolated
- Con: No shared context, wasteful for related issues

### Option B: Project-scoped (proposed)
```
Project "AgentOS v2" → CC Session (workspace: ~/repos/agentos/)
  ├── Works on ENG-7
  ├── Then ENG-8
  └── Maintains context across issues
```
- Pro: Realistic, shared codebase knowledge
- Con: Needs queue management, issue prioritization

### Option C: Repo-scoped
```
Repo "agentos" → CC Session (workspace: ~/repos/agentos/)
  ├── Any issue that maps to this repo goes here
```
- Pro: Most natural mapping
- Con: How to determine repo from issue?

### Recommendation: Hybrid

1. **If issue belongs to a Project** → project-scoped session
   - All issues in the project share one workspace (the repo)
   - CC processes them sequentially in priority order
   - Repo determined by project metadata or `issueRepositorySuggestions`

2. **If issue is standalone** → issue-scoped session
   - Gets its own workspace (current behavior)

3. **Workspace = repo clone, not arbitrary directory**
   - Map project → repo URL → local clone path
   - CC works in the actual repo, not a scratch dir

## Session Lifecycle

```
                    ┌─────────────┐
                    │   Trigger   │
                    │  (any type) │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Find/Create│
                    │   Session   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        Has active    Has idle     No session
         session      session       exists
              │            │            │
              ▼            ▼            ▼
         Pipe msg     Resume &     Spawn new
         into CC      pipe msg     CC session
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────▼──────┐
                    │  CC Works   │
                    │  (monitor)  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         HANDOFF.md   BLOCKED.md    Error/
         (completed)  (needs help)  Timeout
              │            │            │
              ▼            ▼            ▼
         Report to    Elicitation   Report
         Linear +     to Linear +   error +
         next issue   wait for      retry?
                      response
```

## Issue Queue within a Session

When a project-scoped session exists:

```typescript
interface SessionQueue {
  sessionId: string;
  projectId: string;
  workspacePath: string;  // repo path
  currentIssue: string;   // currently working on
  queue: string[];        // pending issues (priority order)
  completed: string[];    // done issues
}
```

When CC finishes an issue (HANDOFF.md):
1. Report completion to Linear
2. Pop next issue from queue
3. Update CLAUDE.md with new issue context
4. Pipe "Now work on ENG-8: <title>" into CC session
5. CC continues in the same session with full context

## Workspace Mapping

```typescript
interface WorkspaceMapping {
  // Project → repo mapping (configured per project)
  projectId: string;
  repoUrl: string;         // e.g., github.com/user/agentos
  localPath: string;       // e.g., ~/repos/agentos
  branch?: string;         // optional: work branch

  // Or use Linear's issueRepositorySuggestions API
  // to auto-detect repo from issue content
}
```

## Configuration (in Linear)

- **Project description** or **project document**: includes repo URL
- **Team guidance**: includes default workspace conventions
- **Issue template**: structured fields for repo, branch, constraints

## Implementation Priority

1. **P0**: Multiple trigger types (not just @mention)
   - Enable "Issues" webhook events for delegation/assignment changes

2. **P0**: Follow-up routing works (prompted → pipe into existing session)

3. **P1**: Project-scoped sessions
   - Project → repo mapping
   - Issue queue management
   - Sequential processing with context continuity

4. **P2**: Intelligent repo detection
   - issueRepositorySuggestions API
   - Or heuristic from issue content/labels

5. **P2**: Parallel sessions for unrelated projects
   - Multiple CC sessions running concurrently
   - Each scoped to a different project/repo
