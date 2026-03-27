/**
 * Linear AgentSession operations: create, dismiss, emit activity, manage plans.
 * Split from linear.ts — see RYA-117 Finding 6, RYA-142.
 */

import { graphql, normalizeBearerToken, getRequiredAgentToken, refreshAgentClient } from './linear-client.js';

/** Emit a terminal response activity to complete an agent session.
 *  NOTE: Linear does NOT allow response activities to be ephemeral. */
async function completeAgentSession(
  token: string,
  agentSessionId: string,
  body: string,
): Promise<void> {
  await graphql(token, `
    mutation($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) { success }
    }
  `, {
    input: {
      agentSessionId,
      content: { type: 'response', body },
    },
  });
}

// --- Agent Session Operations (OAuth client) ---

/** Close active/pending AgentSessions for a specific issue to prevent ghost "Working" states.
 *  Uses dismissAgentSession internally to respect globalDismissedSessions dedup — sessions
 *  already dismissed by the monitor or webhook handler are skipped automatically. */
export async function closeActiveSessionsForIssue(issueIdentifier: string, token: string, reason?: string): Promise<number> {
  const bearerToken = normalizeBearerToken(token);
  if (!bearerToken) return 0;
  try {
    const data = await graphql(bearerToken, `{ agentSessions(first: 50) { nodes { id status issue { identifier } } } }`);
    const sessions = (data.agentSessions as {
      nodes: { id: string; status: string; issue?: { identifier?: string } }[];
    }).nodes;
    let closed = 0;
    for (const s of sessions) {
      if (
        s.issue?.identifier === issueIdentifier &&
        (s.status === 'active' || s.status === 'pending' || s.status === 'awaitingInput' || s.status === 'stale')
      ) {
        // Skip if already dismissed (globalDismissedSessions check is inside dismissAgentSession)
        try {
          await dismissAgentSession(s.id, bearerToken, reason || 'Task completed');
          closed++;
        } catch { /**/ }
      }
    }
    return closed;
  } catch {
    return 0;
  }
}

export async function createAgentSession(issueId: string, externalUrls?: { label: string; url: string }[], overrideToken?: string): Promise<string | null> {
  const token = getRequiredAgentToken(overrideToken);
  if (!token) {
    console.warn('Skipping AgentSession creation: no OAuth token available');
    return null;
  }

  try {
    const data = await graphql(token, `
      mutation($input: AgentSessionCreateOnIssue!) {
        agentSessionCreateOnIssue(input: $input) {
          success
          agentSession { id status }
        }
      }
    `, {
      input: {
        issueId,
        ...(externalUrls ? { externalUrls } : {}),
      },
    });
    const result = data.agentSessionCreateOnIssue as { success: boolean; agentSession: { id: string } } | undefined;
    return result?.agentSession?.id ?? null;
  } catch (err) {
    console.error('Failed to create AgentSession:', (err as Error).message);
    return null;
  }
}

export async function emitActivity(
  agentSessionId: string,
  content: { type: string; body?: string; action?: string; parameter?: string; result?: string },
  ephemeral = false,
  overrideToken?: string
): Promise<void> {
  if (!agentSessionId) return;
  const token = getRequiredAgentToken(overrideToken);
  if (!token) {
    console.warn('Skipping agent activity emit: no OAuth token available');
    return;
  }

  try {
    await graphql(token, `
      mutation($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success }
      }
    `, {
      input: { agentSessionId, content, ephemeral },
    });
  } catch (err) {
    console.error('Failed to emit activity:', (err as Error).message);
  }
}

export async function updateAgentPlan(
  agentSessionId: string,
  steps: { content: string; status: 'pending' | 'inProgress' | 'completed' | 'canceled' }[]
): Promise<void> {
  if (!agentSessionId) return;
  const token = getRequiredAgentToken();
  if (!token) {
    console.warn('Skipping agent plan update: no OAuth token available');
    return;
  }

  try {
    await graphql(token, `
      mutation($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) { success }
      }
    `, { id: agentSessionId, input: { plan: { steps } } });
  } catch (err) {
    console.error('Failed to update plan:', (err as Error).message);
  }
}

/** Track dismissed AgentSession IDs globally to prevent double-dismiss across subsystems.
 *  The janitor (scheduler.ts) checks this before dismissing sessions that the monitor already handled. */
export const globalDismissedSessions = new Set<string>();

/** Dismiss/close an AgentSession so Linear stops showing "Working".
 *  Linear auto-manages session state based on a terminal response activity. */
export async function dismissAgentSession(agentSessionId: string, overrideToken?: string, reason?: string): Promise<void> {
  if (globalDismissedSessions.has(agentSessionId)) return; // Already dismissed — skip to prevent duplicate noise

  const token = getRequiredAgentToken(overrideToken);
  if (!token) {
    console.error('Cannot dismiss agent session: no OAuth token available');
    return;
  }

  // Use '–' as minimal dismiss body for cleanup/dedup paths (RYA-103).
  // Meaningful dismiss messages should be provided by callers (monitor HANDOFF, idle, etc.).
  const body = reason && reason.trim() ? reason : '–';

  await completeAgentSession(token, agentSessionId, body);
  globalDismissedSessions.add(agentSessionId);
}

export async function addExternalLink(
  agentSessionId: string,
  links: { label: string; url: string }[]
): Promise<void> {
  if (!agentSessionId) return;
  const token = getRequiredAgentToken();
  if (!token) {
    console.warn('Skipping external link update: no OAuth token available');
    return;
  }

  try {
    await graphql(token, `
      mutation($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) { success }
      }
    `, { id: agentSessionId, input: { addedExternalUrls: links } });
  } catch (err) {
    console.error('Failed to add external link:', (err as Error).message);
  }
}

export interface AgentSessionInfo {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  issue?: {
    identifier?: string;
    title?: string;
    state?: { name?: string };
  };
}

export async function listAgentSessions(overrideToken?: string): Promise<AgentSessionInfo[]> {
  const token = getRequiredAgentToken(overrideToken);
  if (!token) return [];

  try {
    const data = await graphql(token, `
      query {
        agentSessions(first: 100) {
          nodes {
            id
            status
            createdAt
            updatedAt
            issue {
              identifier
              title
              state { name }
            }
          }
        }
      }
    `);
    return (data.agentSessions as { nodes: AgentSessionInfo[] }).nodes ?? [];
  } catch (err) {
    console.error('Failed to list AgentSessions:', (err as Error).message);
    return [];
  }
}
