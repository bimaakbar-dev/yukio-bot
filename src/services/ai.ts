import type { Env } from '../types/env';

/** Model default untuk semua AI calls */
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Chat dengan AI menggunakan Workers AI.
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
  const { system, maxTokens = 500, temperature = 0.7 } = options ?? {};

  const messages: AIMessage[] = [];

  if (system) {
    messages.push({ role: 'system', content: system });
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
  const { maxTokens = 500, temperature = 0.7 } = options ?? {};

  return runAI(env, messages, { maxTokens, temperature });
}

/**
 * Low-level function — panggil Workers AI dan extract response.
 */
async function runAI(
  env: Env,
  messages: AIMessage[],
  options: { maxTokens: number; temperature: number }
): Promise<string> {
  try {
    const res = await env.AI.run(DEFAULT_MODEL, {
      messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
    });

    const response = (res as { response?: string }).response ?? '';

    return response.trim();
  } catch (err) {
    console.error('[AI] error:', err);
    return '';
  }
}