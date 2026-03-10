/**
 * Claude Agent SDK wrapper for Agent Factory.
 *
 * Thin wrapper around @anthropic-ai/claude-agent-sdk that provides
 * a clean interface for spawning AI agents programmatically.
 * This is the "quick fix" — Astra will replace this later.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface RunAgentOptions {
  model?: string;
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  cwd?: string;
  outputFile?: string;
}

export interface AgentResult {
  result: string;
  durationMs: number;
  numTurns: number;
  success: boolean;
}

/**
 * Run an agent to completion using the Claude Agent SDK.
 * Returns the final result text.
 */
export async function runAgent(
  systemPrompt: string,
  taskPrompt: string,
  options: RunAgentOptions = {},
): Promise<AgentResult> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const stream = query({
    prompt: taskPrompt,
    options: {
      systemPrompt,
      model: options.model || 'sonnet',
      maxTurns: options.maxTurns || 50,
      allowedTools: options.tools || [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      ],
      disallowedTools: options.disallowedTools,
      cwd: options.cwd || process.cwd(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
    },
  });

  let resultText = '';
  let allText = '';   // ORA-163: Accumulate text from intermediate assistant turns
  let durationMs = 0;
  let numTurns = 0;
  let success = false;

  for await (const event of stream) {
    // ORA-163: Capture text from intermediate assistant turns (multi-turn tool use).
    // When the SDK's result event is empty, this is the fallback.
    if (event.type === 'assistant') {
      const msg = (event as any).message;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            allText += block.text + '\n';
          }
        }
      }
    } else if (event.type === 'result') {
      const r = event as any;
      resultText = r.result || '';
      durationMs = r.duration_ms || 0;
      numTurns = r.num_turns || 0;
      success = r.subtype === 'success';
    }
  }

  // ORA-163: Fallback — use accumulated assistant text when result event is empty
  const finalText = resultText || allText.trim();
  if (!resultText && allText.trim()) {
    console.warn(`[sdk] result event empty but assistant turns produced ${allText.length} chars — using fallback`);
  }

  return { result: finalText, durationMs, numTurns, success };
}
