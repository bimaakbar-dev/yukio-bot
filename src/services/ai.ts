import type { Env } from '../types/env';

/**
 * Model list — dicoba berurutan sampai ada yang berhasil.
 * Model ringan duluan karena lebih stabil di Workers AI.
 */
const MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistral/mistral-7b-instruct-v0.1',
];

interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Ekstrak string dari response Workers AI.
 * Format response bisa berbeda antar model.
 */
function extractResponse(res: unknown): string {
  if (!res) return '';
  if (typeof res === 'string') return res;

  const obj = res as Record<string, unknown>;
  if (typeof obj.response === 'string') return obj.response;
  if (typeof obj.result === 'string') return obj.result;

  const choices = obj.choices as
    | { message?: { content?: string } }[]
    | undefined;
  if (choices?.[0]?.message?.content) return choices[0].message.content;

  return '';
}

/**
 * Coba beberapa model sampai berhasil.
 */
async function runAI(
  env: Env,
  messages: AIMessage[],
  options: { maxTokens: number; temperature: number }
): Promise<string> {
  const errors: string[] = [];

  for (const model of MODELS) {
    try {
      console.log(`[AI] Trying model: ${model}`);

      const res = await env.AI.run(
        model as Parameters<Ai['run']>[0],
        {
          messages,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
        } as Parameters<Ai['run']>[1]
      );

      const text = extractResponse(res).trim();

      if (text) {
        console.log(`[AI] ${model} OK (${text.length} chars)`);
        return text;
      }

      console.warn(`[AI] ${model} returned empty`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${model}: ${msg}`);
      console.warn(`[AI] ${model} failed:`, msg);
    }
  }

  console.error('[AI] All models failed:', errors);
  return '';
}

/**
 * Chat dengan AI — one-shot prompt.
 * Return string kosong kalau error (fail-safe).
 */
export async function askAI(
  env: Env,
  prompt: string,
  options?: {
    system?: string;
    maxTokens?: number;
    temperature?: number;
  }
): Promise<string> {
  const opts = options ?? {};
  const maxTokens = opts.maxTokens ?? 800;
  const temperature = opts.temperature ?? 0.7;

  const messages: AIMessage[] = [];

  if (opts.system) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: prompt });

  return runAI(env, messages, { maxTokens, temperature });
}

/**
 * Chat dengan history percakapan (multi-turn).
 */
export async function chatAI(
  env: Env,
  messages: AIMessage[],
  options?: {
    maxTokens?: number;
    temperature?: number;
  }
): Promise<string> {
  const opts = options ?? {};
  const maxTokens = opts.maxTokens ?? 800;
  const temperature = opts.temperature ?? 0.7;

  return runAI(env, messages, { maxTokens, temperature });
}