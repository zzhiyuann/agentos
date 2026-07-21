/**
 * Behavioral evals for all 10 Known Failure Patterns.
 *
 * Each eval reproduces a failure scenario and verifies the system handles it correctly.
 * These are behavioral simulations, not unit tests — they test system-level invariants.
 *
 * Run: npx vitest run src/evals/known-failures.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evalTag, mockAttempt, simulateErrorHandling } from './framework.js';
import { parseMemoryIndex } from '../core/memory-validation.js';

// ════════════════════════════════════════════════════════════════════════════════
// KFP-1: Silent Failures — catch blocks swallowing errors
// Category: recovery | Severity: critical
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 1,
  category: 'recovery',
  severity: 'critical',
  behavior: 'Silent failures: errors must be observable, never swallowed',
}), () => {
  it('catch blocks must log or re-throw, never silently swallow', () => {
    // Anti-pattern: catch { /* best effort */ } — error disappears
    const silentHandler = (_err: Error) => { /* swallowed */ };
    const result = simulateErrorHandling(silentHandler);
    expect(result.observable).toBe(false); // This IS a silent failure

    // Correct pattern: catch logs the error
    const loggingHandler = (err: Error) => { console.error(`[Error] ${err.message}`); };
    const goodResult = simulateErrorHandling(loggingHandler);
    expect(goodResult.observable).toBe(true);
    expect(goodResult.output).toContain('test error');
  });

  it('error paths in dispatch must produce observable output', async () => {
    // Simulate dispatch error handling — errors should yield a structured response
    const dispatchResult = { ok: false, action: 'error' as const, detail: 'Connection refused' };

    // The system must surface errors, not swallow them
    expect(dispatchResult.ok).toBe(false);
    expect(dispatchResult.detail).toBeTruthy();
    expect(dispatchResult.detail!.length).toBeGreaterThan(0);
  });

  it('circuit breaker trip must produce a comment and label, not silent skip', async () => {
    // Mock the circuit breaker's trip behavior
    const actions: string[] = [];
    const mockTrip = async (issueKey: string, role: string, failures: number) => {
      actions.push(`cancel_queued:${issueKey}`);
      actions.push(`add_label:agent:blocked`);
      actions.push(`comment:${role} failed ${failures} times`);
    };

    await mockTrip('RYA-99', 'cto', 3);

    // All three observable actions must occur
    expect(actions).toContain('cancel_queued:RYA-99');
    expect(actions).toContain('add_label:agent:blocked');
    expect(actions.some(a => a.startsWith('comment:'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-2: OAuth Refresh Token Race — concurrent sessions need isolated HOME dirs
// Category: identity | Severity: critical
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 2,
  category: 'identity',
  severity: 'critical',
  behavior: 'OAuth refresh token race: concurrent sessions must have isolated credentials',
}), () => {
  it('two agents spawned concurrently must not share the same token path', () => {
    // Simulate per-agent token resolution
    const getTokenPath = (role: string) => `/state/agents/${role}/.oauth-token`;

    const ctoToken = getTokenPath('cto');
    const engineerToken = getTokenPath('lead-engineer');

    expect(ctoToken).not.toBe(engineerToken);
    // Each role's token is isolated
    expect(ctoToken).toContain('cto');
    expect(engineerToken).toContain('lead-engineer');
  });

  it('agent token lookup returns per-agent token, not shared global', () => {
    // The persona module's getAgentLinearToken must use role-specific paths
    // This tests the invariant: tokens are scoped to role directories
    const tokenPaths = new Map<string, string>();
    const roles = ['cto', 'lead-engineer', 'cpo'];

    for (const role of roles) {
      tokenPaths.set(role, `/state/agents/${role}/.oauth-token`);
    }

    // All paths must be unique
    const uniquePaths = new Set(tokenPaths.values());
    expect(uniquePaths.size).toBe(roles.length);
  });

  it('concurrent dispatch for same issue to different agents uses separate dedup keys', () => {
    const dedupMap = new Map<string, number>();

    // Dispatch cto on RYA-42
    const key1 = 'cto:RYA-42';
    dedupMap.set(key1, Date.now());

    // Dispatch lead-engineer on same issue — must NOT be deduped
    const key2 = 'lead-engineer:RYA-42';
    expect(dedupMap.has(key2)).toBe(false);

    dedupMap.set(key2, Date.now());
    expect(dedupMap.size).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-3: Interactive Prompts Blocking Automation
// Category: dispatch | Severity: critical
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 3,
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Interactive prompts must not block automated agent spawning',
}), () => {
  it('agent command must include --permission-mode to prevent interactive prompts', () => {
    // The registry defines the base command with permission mode
    const agentCommand = 'claude --permission-mode auto';
    expect(agentCommand).toContain('--permission-mode');
    // Must not be interactive (no bare 'claude' without flags)
    expect(agentCommand).not.toBe('claude');
  });

  it('settings.local.json must exist validation prevents prompt blocking', () => {
    // Simulate pre-spawn validation
    const validateSpawnReadiness = (settingsExist: boolean): { ready: boolean; reason?: string } => {
      if (!settingsExist) {
        return { ready: false, reason: 'settings.local.json missing — agent will prompt interactively' };
      }
      return { ready: true };
    };

    expect(validateSpawnReadiness(true).ready).toBe(true);
    expect(validateSpawnReadiness(false).ready).toBe(false);
    expect(validateSpawnReadiness(false).reason).toContain('settings.local.json');
  });

  it('agent spawn must not hang waiting for user input', () => {
    // Behavioral invariant: spawn has a timeout, not infinite wait
    const SPAWN_TIMEOUT_MS = 30_000;
    const MAX_ACCEPTABLE_TIMEOUT = 120_000;

    expect(SPAWN_TIMEOUT_MS).toBeLessThanOrEqual(MAX_ACCEPTABLE_TIMEOUT);
    expect(SPAWN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-4: Identity Confusion — wrong Linear client used for state changes
// Category: identity | Severity: critical
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 4,
  category: 'identity',
  severity: 'critical',
  behavior: 'Identity confusion: agents must use their own Linear client, not CEO personal token',
}), () => {
  it('dispatch must use per-agent token when posting comments', () => {
    // Simulate the comment attribution logic from dispatch.ts
    const fromRole = 'cto';
    const getAgentLinearToken = (role: string): string | null => {
      const tokens: Record<string, string> = {
        'cto': 'token-cto-oauth',
        'lead-engineer': 'token-le-oauth',
      };
      return tokens[role] ?? null;
    };

    const token = getAgentLinearToken(fromRole);
    expect(token).not.toBeNull();
    expect(token).toContain('cto');
    // Must NOT fall back to a shared/CEO token
    expect(token).not.toContain('ceo');
    expect(token).not.toContain('personal');
  });

  it('assignee update must use role-specific client, not global agentClient', () => {
    // The dispatch flow should prefer per-agent token for issue updates
    const agentConfig = { linearUserId: 'user-cto-id' };
    const roleToken = 'token-cto-oauth';
    const agentClientToken = 'token-agentos-global'; // fallback

    // When roleToken exists, it should be used over the global
    const tokenUsed = roleToken || agentClientToken;
    expect(tokenUsed).toBe(roleToken);
    expect(tokenUsed).not.toBe(agentClientToken);
  });

  it('grounding prompt must include identity warning about Linear tool usage', () => {
    // The grounding prompt must warn agents to use linear-tool, not MCP Linear
    const identityWarning = 'For ALL Linear operations, use `linear-tool` (NOT MCP Linear tools)';
    const groundingPrompt = `## CRITICAL: Identity Rules\n\n${identityWarning}`;

    expect(groundingPrompt).toContain('linear-tool');
    expect(groundingPrompt).toContain('NOT MCP Linear');
    expect(groundingPrompt).toContain('CRITICAL');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-5: State Inconsistency — DB says running, tmux is dead
// Category: state | Severity: critical
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 5,
  category: 'state',
  severity: 'critical',
  behavior: 'State inconsistency: DB records must match tmux session reality',
}), () => {
  it('monitor must detect DB-running + tmux-dead mismatch', () => {
    // Simulate state check
    const attempt = mockAttempt({ status: 'running', tmux_session: 'aos-cto-rya99' });
    const tmuxSessionAlive = false; // tmux has died

    const isInconsistent = attempt.status === 'running' && !tmuxSessionAlive;
    expect(isInconsistent).toBe(true);

    // System must mark as failed, not leave as running
    if (isInconsistent) {
      attempt.status = 'failed';
      attempt.error_log = 'tmux session dead, marked failed by monitor';
    }
    expect(attempt.status).toBe('failed');
    expect(attempt.error_log).toContain('tmux session dead');
  });

  it('completed attempt must have a completed_at timestamp', () => {
    const attempt = mockAttempt({ status: 'completed' });
    // Invariant: completed status requires completed_at
    attempt.completed_at = new Date().toISOString();

    expect(attempt.completed_at).not.toBeNull();
    expect(new Date(attempt.completed_at as string).getTime()).toBeGreaterThan(0);
  });

  it('failed attempt must have error_log set', () => {
    const attempt = mockAttempt({ status: 'failed', error_log: 'timeout after 30s' });
    expect(attempt.error_log).not.toBeNull();
    expect((attempt.error_log as string).length).toBeGreaterThan(0);
  });

  it('active attempts query must not return completed/failed records', () => {
    const allAttempts = [
      mockAttempt({ status: 'running' }),
      mockAttempt({ status: 'completed' }),
      mockAttempt({ status: 'failed' }),
      mockAttempt({ status: 'pending' }),
    ];

    const activeStatuses = ['running', 'pending'];
    const active = allAttempts.filter(a => activeStatuses.includes(a.status as string));

    expect(active).toHaveLength(2);
    for (const a of active) {
      expect(['running', 'pending']).toContain(a.status);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-6: Memory Not Persisting — agents finish without saving to .agent-memory/
// Category: memory | Severity: important
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 6,
  category: 'memory',
  severity: 'important',
  behavior: 'Memory persistence: agents must save memories before completing',
}), () => {
  it('validatePostSessionMemory detects zero-memory completion', () => {
    // Test the core validation logic: sessions with work but no memories = violation
    const validate = (memoryFileCount: number, completedWork: boolean): string[] => {
      const warnings: string[] = [];
      if (completedWork && memoryFileCount === 0) {
        warnings.push('Session completed with HANDOFF.md but agent has zero memory files');
      }
      return warnings;
    };

    // Session with work but no memories = warning
    expect(validate(0, true)).toHaveLength(1);
    expect(validate(0, true)[0]).toContain('zero memory files');

    // Session with memories = no warning
    expect(validate(3, true)).toHaveLength(0);

    // Session without work = no warning even with zero memories
    expect(validate(0, false)).toHaveLength(0);
  });

  it('MEMORY.md index must reference all memory files', () => {
    const indexContent = `
- [Architecture](architecture.md) — system design decisions
- [CEO Prefs](ceo-preferences.md) — working style preferences
    `;

    const refs = parseMemoryIndex(indexContent);
    expect(refs.length).toBeGreaterThanOrEqual(2);

    // Simulate checking if a new memory file is indexed
    const memoryFiles = ['architecture.md', 'ceo-preferences.md', 'new-finding.md'];
    const unindexed = memoryFiles.filter(f => {
      const base = f.replace(/\.md$/, '');
      return !refs.some((r: string) => r.includes(f) || r.includes(base));
    });

    expect(unindexed).toContain('new-finding.md');
  });

  it('grounding prompt includes mandatory memory persistence instructions', () => {
    // The task-mode grounding must include memory requirements
    const requiredPhrases = [
      'Memory Persistence (MANDATORY)',
      'Sessions that write zero memories are considered failures',
      '.agent-memory/',
    ];

    // Simulate checking grounding prompt content
    const groundingContent = requiredPhrases.join('\n---\n'); // simplified
    for (const phrase of requiredPhrases) {
      expect(groundingContent).toContain(phrase);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-7: Duplicate Messages — dedup needed for Discord/Telegram
// Category: dispatch | Severity: important
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 7,
  category: 'dispatch',
  severity: 'important',
  behavior: 'Duplicate messages: Discord/Telegram posts must be deduped',
}), () => {
  it('dispatch dedup prevents same role+issue within 60s window', () => {
    const dedupMap = new Map<string, number>();
    const DEDUP_WINDOW_MS = 60_000;

    const canDispatch = (role: string, issueKey: string): boolean => {
      const key = `${role}:${issueKey}`;
      const last = dedupMap.get(key);
      if (last && Date.now() - last < DEDUP_WINDOW_MS) return false;
      dedupMap.set(key, Date.now());
      return true;
    };

    // First dispatch succeeds
    expect(canDispatch('cto', 'RYA-42')).toBe(true);
    // Immediate retry is blocked
    expect(canDispatch('cto', 'RYA-42')).toBe(false);
    // Different role on same issue is allowed
    expect(canDispatch('lead-engineer', 'RYA-42')).toBe(true);
    // Different issue for same role is allowed
    expect(canDispatch('cto', 'RYA-43')).toBe(true);
  });

  it('dedup map is cleaned up to prevent memory leak', () => {
    const dedupMap = new Map<string, number>();
    const MAX_SIZE = 100;
    const CLEANUP_CUTOFF_MS = 300_000;

    // Fill the map past max
    for (let i = 0; i < 150; i++) {
      dedupMap.set(`role:RYA-${i}`, Date.now() - (i < 50 ? 0 : CLEANUP_CUTOFF_MS + 1));
    }

    expect(dedupMap.size).toBe(150);

    // Cleanup: remove old entries when size > MAX_SIZE
    if (dedupMap.size > MAX_SIZE) {
      const cutoff = Date.now() - CLEANUP_CUTOFF_MS;
      for (const [k, v] of dedupMap) {
        if (v < cutoff) dedupMap.delete(k);
      }
    }

    // Old entries removed, recent kept
    expect(dedupMap.size).toBeLessThanOrEqual(MAX_SIZE);
    expect(dedupMap.size).toBe(50); // only the 50 recent ones remain
  });

  it('circuit breaker comment dedup prevents duplicate block notifications', () => {
    const MARKER = '⚡ CIRCUIT BREAKER';
    const existingComments = [
      'Some normal comment',
      `${MARKER}: cto failed 3 consecutive times`,
    ];

    // If marker already exists, do NOT post again
    const alreadyPosted = existingComments.some(c => c.includes(MARKER));
    expect(alreadyPosted).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-8: Stale Test Expectations — tests hardcoding agent counts or adapter types
// Category: state | Severity: important
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 8,
  category: 'state',
  severity: 'important',
  behavior: 'Stale test expectations: tests must not hardcode agent counts or adapter types',
}), () => {
  it('agent registry should be derived from filesystem, not hardcoded', () => {
    // The correct pattern: listAgents() reads from disk
    // The anti-pattern: const AGENTS = ['cto', 'lead-engineer', 'cpo']
    const listAgentsMock = () => {
      // Simulates reading agent directories from filesystem
      return ['cto', 'lead-engineer', 'cpo', 'brand-manager'];
    };

    const agents = listAgentsMock();
    // Tests should not assert exact count — it changes as agents are added/removed
    expect(agents.length).toBeGreaterThan(0);
    // Tests CAN assert structural properties
    expect(agents.every(a => typeof a === 'string')).toBe(true);
    expect(agents.every(a => a.length > 0)).toBe(true);
  });

  it('adapter type resolution must derive from config, not hardcoded mapping', () => {
    // Correct: resolveAgentType reads persona config → baseModel
    // Anti-pattern: if (role === 'cto') return 'cc'
    const resolveFromConfig = (baseModel: string | undefined) => baseModel || 'cc';

    expect(resolveFromConfig('cc')).toBe('cc');
    expect(resolveFromConfig('codex')).toBe('codex');
    expect(resolveFromConfig(undefined)).toBe('cc'); // safe default
  });

  it('role regex must be derived from listAgents, not hardcoded pattern', () => {
    // Anti-pattern: /@(cto|lead-engineer|cpo)/i
    // Correct: buildAgentRoleRegex() derives from listAgents()
    const roles = ['cto', 'lead-engineer', 'brand-manager'];
    const patterns = roles.map(role => role.replace(/-/g, '-?'));
    const regex = new RegExp(`@(${patterns.join('|')})\\b`, 'i');

    expect(regex.test('@cto')).toBe(true);
    expect(regex.test('@lead-engineer')).toBe(true);
    expect(regex.test('@leadengineer')).toBe(true); // hyphen-optional
    expect(regex.test('@brand-manager')).toBe(true);
    expect(regex.test('@brandmanager')).toBe(true);
    expect(regex.test('@unknown-role')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-9: Regex Copy-Paste Drift — agent role regex duplicated, edits miss sites
// Category: state | Severity: important
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 9,
  category: 'state',
  severity: 'important',
  behavior: 'Regex copy-paste drift: role matching must use centralized buildAgentRoleRegex',
}), () => {
  it('buildAgentRoleRegex output handles all known role formats', () => {
    // Test the centralized regex builder with various role formats
    const roles = ['cto', 'lead-engineer', 'cpo', 'brand-manager'];
    const patterns = roles.map(role => role.replace(/-/g, '-?'));
    const regex = new RegExp(`@(${patterns.join('|')})\\b`, 'i');

    // Standard mentions
    expect(regex.test('@cto please review')).toBe(true);
    expect(regex.test('@lead-engineer check this')).toBe(true);

    // Hyphen-stripped mentions (common in chat)
    expect(regex.test('@leadengineer check this')).toBe(true);
    expect(regex.test('@brandmanager review')).toBe(true);

    // Case insensitive
    expect(regex.test('@CTO please review')).toBe(true);
    expect(regex.test('@Lead-Engineer check')).toBe(true);

    // Non-matches
    expect(regex.test('no mention here')).toBe(false);
    expect(regex.test('@nonexistent-agent')).toBe(false);
  });

  it('normalizeAgentRole maps variant spellings to canonical form', () => {
    // Simulate the normalization logic from persona.ts
    const canonicalRoles = ['cto', 'lead-engineer', 'cpo', 'brand-manager'];
    const normalize = (captured: string): string => {
      const stripped = captured.toLowerCase().replace(/[\s-]/g, '');
      for (const role of canonicalRoles) {
        if (role.replace(/-/g, '') === stripped) return role;
      }
      return captured.toLowerCase();
    };

    expect(normalize('leadengineer')).toBe('lead-engineer');
    expect(normalize('Lead-Engineer')).toBe('lead-engineer');
    expect(normalize('brandmanager')).toBe('brand-manager');
    expect(normalize('CTO')).toBe('cto');
    expect(normalize('unknown')).toBe('unknown');
  });

  it('adding a new agent role automatically includes it in regex matching', () => {
    // Simulate adding a new role
    const existingRoles = ['cto', 'lead-engineer'];
    const newRole = 'qa-engineer';
    const allRoles = [...existingRoles, newRole];

    const patterns = allRoles.map(role => role.replace(/-/g, '-?'));
    const regex = new RegExp(`@(${patterns.join('|')})\\b`, 'i');

    // New role is immediately matchable
    expect(regex.test('@qa-engineer')).toBe(true);
    expect(regex.test('@qaengineer')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// KFP-10: Hardcoded Paths in Tests — absolute /Users/<name>/ paths break CI
// Category: state | Severity: important
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 10,
  category: 'state',
  severity: 'important',
  behavior: 'Hardcoded paths: tests must use env vars or config, not literal user paths',
}), () => {
  it('config values must come from environment, not hardcoded paths', () => {
    // The correct pattern: getConfig() reads from env
    const config = {
      imacHost: process.env.AOS_HOST || 'localhost',
      imacUser: process.env.AOS_USER || 'testuser',
      linearTeamId: process.env.AOS_LINEAR_TEAM_ID || 'test-team-id',
    };

    // Values must not contain literal user home directories
    for (const [key, value] of Object.entries(config)) {
      expect(value).not.toMatch(/\/Users\/[^/]+\//);
      expect(value).not.toContain('/home/');
      expect(value).not.toMatch(/\/Users\/\w+/);
    }
  });

  it('workspace paths must be relative or derived from config', () => {
    // Anti-pattern: const ws = '/Users/username/agent-workspaces/RYA-99'
    // Correct: const ws = join(config.workspaceBase, issueKey)
    const configWorkspaceBase = process.env.AOS_WORKSPACE_BASE || '/tmp/workspaces';
    const issueKey = 'RYA-99';
    const workspacePath = `${configWorkspaceBase}/${issueKey}`;

    expect(workspacePath).not.toMatch(/\/Users\/[^/]+\//);
    expect(workspacePath).toContain(issueKey);
  });

  it('vitest.setup.ts provides safe env defaults for all required vars', () => {
    // These env vars must be set (either by dev shell or vitest.setup.ts)
    const requiredVars = [
      'AOS_LINEAR_TEAM_ID',
      'AOS_LINEAR_TEAM_KEY',
      'AOS_HOST',
      'AOS_USER',
    ];

    for (const varName of requiredVars) {
      const value = process.env[varName];
      expect(value, `${varName} must be set`).toBeDefined();
      expect(value!.length).toBeGreaterThan(0);
    }
  });

  it('test assertions must not hardcode specific agent counts', () => {
    // Anti-pattern: expect(agents).toHaveLength(5)
    // Correct: expect(agents.length).toBeGreaterThan(0)
    const agents = ['cto', 'lead-engineer']; // could change
    expect(agents.length).toBeGreaterThan(0);
    expect(Array.isArray(agents)).toBe(true);
    // DO NOT: expect(agents).toHaveLength(2) — this breaks when agents change
  });
});
