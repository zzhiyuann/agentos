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
  /** A4.4: Claude model id override (e.g. claude-sonnet-4-6). When set, the
   *  Claude Code adapter passes `--model`; unset = runner's default model. */
  model?: string;
  /** When true, inject ANTHROPIC_LOG=info / CODEX_LOG=info so the runner emits
   *  the API request/response supplement RYA-888 / RYA-844 needs for replay. */
  captureMode?: boolean;
}

export interface SpawnResult {
  tmuxSession?: string;
  runnerSessionId?: string;
  isolatedHome?: string;
}

/** Returns true when capture mode (ANTHROPIC_LOG/CODEX_LOG) should be injected.
 *  Explicit opts.captureMode wins over AOS_CAPTURE_MODE env var. */
export function isCaptureModeEnabled(opts: { captureMode?: boolean }): boolean {
  if (opts.captureMode !== undefined) return opts.captureMode;
  const env = process.env.AOS_CAPTURE_MODE;
  return env === '1' || env === 'true';
}
