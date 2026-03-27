/** Unified runner adapter interface for all agent types */
export interface RunnerAdapter {
  /** Spawn a new agent session */
  spawn(opts: SpawnOptions): Promise<SpawnResult>;

  /** Resume an existing session */
  resume?(sessionId: string, prompt?: string): Promise<void>;

  /** Fork an existing session into a new one */
  fork?(sessionId: string, prompt?: string): Promise<SpawnResult>;

  /** Check if a session is still alive */
  isAlive(sessionId: string): boolean;

  /** Kill a running session */
  kill(sessionId: string): void;

  /** Get the last N lines of output */
  captureOutput(sessionId: string, lines?: number): string;
}

export interface SpawnOptions {
  issueKey: string;
  title: string;
  description?: string;
  systemPrompt: string;
  initialPrompt: string;
  workspacePath: string;
  attemptNumber: number;
  agentRole?: string;  // e.g., 'cto', 'lead-engineer'
  isFollowUp?: boolean; // conversation mode — skip HANDOFF_TEMPLATE, lighter setup
}

export interface SpawnResult {
  tmuxSession?: string;
  runnerSessionId?: string;
  isolatedHome?: string;
}
