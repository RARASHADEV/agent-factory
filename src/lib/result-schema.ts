/**
 * AF-23: Structured agent output — ResultSchema definition, validation,
 * extraction from result.md, and synthesis fallback.
 *
 * Agents emit a ```result-json fenced block in their output.
 * spawn-runner extracts it, validates against ResultSchema, and writes
 * result.json to the output directory. If no valid block is found,
 * a synthetic result is generated from status.json data.
 */

// --- Types ---

export type ResultStatus = 'complete' | 'partial' | 'failed' | 'blocked';

export interface ResultArtifact {
  type: string;   // e.g., "design_document", "pull_request", "qa_verdict"
  path: string;   // relative file path or URL
}

export interface ResultSchema {
  status: ResultStatus;
  summary: string;                          // one-line human-readable summary
  artifacts: ResultArtifact[];              // files/URLs the agent produced
  next_role?: string;                       // e.g., "ENGINEER", "QA"
  blockers?: string[];                      // what prevented completion
  metadata?: Record<string, unknown>;       // agent-specific structured data
  _synthetic?: boolean;                     // true = system-generated, not agent-produced
}

// --- Validation ---

export interface ValidationSuccess {
  valid: true;
  data: ResultSchema;
}

export interface ValidationFailure {
  valid: false;
  errors: string[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

const VALID_STATUSES: readonly string[] = ['complete', 'partial', 'failed', 'blocked'];

/**
 * Validate an unknown input against the ResultSchema.
 * Hand-rolled — no external dependencies.
 */
export function validateResult(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a plain object'] };
  }

  const obj = input as Record<string, unknown>;

  // status: required, must be one of the four allowed values
  if (typeof obj.status !== 'string' || !VALID_STATUSES.includes(obj.status)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')} (got ${JSON.stringify(obj.status)})`);
  }

  // summary: required, non-empty string
  if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) {
    errors.push('summary must be a non-empty string');
  }

  // artifacts: required, array of { type: string, path: string }
  if (!Array.isArray(obj.artifacts)) {
    errors.push('artifacts must be an array');
  } else {
    for (let i = 0; i < obj.artifacts.length; i++) {
      const a = obj.artifacts[i];
      if (typeof a !== 'object' || a === null || Array.isArray(a)) {
        errors.push(`artifacts[${i}] must be an object`);
      } else {
        const art = a as Record<string, unknown>;
        if (typeof art.type !== 'string') {
          errors.push(`artifacts[${i}].type must be a string`);
        }
        if (typeof art.path !== 'string') {
          errors.push(`artifacts[${i}].path must be a string`);
        }
      }
    }
  }

  // next_role: optional, must be string if present
  if (obj.next_role !== undefined && typeof obj.next_role !== 'string') {
    errors.push('next_role must be a string if provided');
  }

  // blockers: optional, must be array of strings if present
  if (obj.blockers !== undefined) {
    if (!Array.isArray(obj.blockers)) {
      errors.push('blockers must be an array if provided');
    } else {
      for (let i = 0; i < obj.blockers.length; i++) {
        if (typeof obj.blockers[i] !== 'string') {
          errors.push(`blockers[${i}] must be a string`);
        }
      }
    }
  }

  // metadata: optional, must be a plain object if present
  if (obj.metadata !== undefined) {
    if (typeof obj.metadata !== 'object' || obj.metadata === null || Array.isArray(obj.metadata)) {
      errors.push('metadata must be a plain object if provided');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: input as ResultSchema };
}

// --- Extraction ---

/**
 * Regex to match ```result-json fenced blocks.
 * Takes the LAST match (agents may revise their output).
 */
const RESULT_JSON_FENCE = /```result-json\s*\n([\s\S]*?)```/g;

/**
 * Extract a result-json block from result.md text.
 *
 * Returns null if no ```result-json block found.
 * Returns ValidationResult if block found (may still be invalid).
 */
export function extractResultJson(resultText: string): ValidationResult | null {
  const matches = [...resultText.matchAll(RESULT_JSON_FENCE)];
  if (matches.length === 0) return null;

  // Take the last match — the definitive one if the agent revised
  const jsonStr = matches[matches.length - 1][1].trim();

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e: any) {
    return { valid: false, errors: [`JSON parse error: ${e.message}`] };
  }

  // Validate against schema
  return validateResult(parsed);
}

// --- Synthesis ---

export interface SynthesisInput {
  status: string;
  success?: boolean;
  agent?: string;
  ticket?: string;
}

/**
 * Build a minimal synthetic ResultSchema from status.json data.
 * Used when the agent didn't emit a valid result-json block.
 */
export function synthesizeResult(input: SynthesisInput): ResultSchema {
  let resultStatus: ResultStatus;
  if (input.success) {
    resultStatus = 'complete';
  } else if (input.status === 'failed') {
    resultStatus = 'failed';
  } else {
    resultStatus = 'partial';
  }

  return {
    status: resultStatus,
    summary: `Agent ${input.agent || 'unknown'} finished on ${input.ticket || 'unknown task'} (no structured output)`,
    artifacts: [],
    _synthetic: true,
  };
}
