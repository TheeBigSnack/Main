// A stand-in for @anthropic-ai/sdk, for test/backend.test.js. Its answers
// come from FAKE_ANTHROPIC, a JSON list taken in order (the last one
// repeats): { delayMs, text, stop, input, output }. Each call is written as
// a line of JSON to FAKE_ANTHROPIC_LOG when it ends, answered or stopped by
// its signal, as the real SDK stops a call whose signal aborts.

import { appendFileSync } from 'node:fs';

class APIError extends Error {}
class APIUserAbortError extends APIError {}
class AuthenticationError extends APIError {}
class RateLimitError extends APIError {}
class APIConnectionError extends APIError {}

const script = JSON.parse(process.env.FAKE_ANTHROPIC || '[]');
let calls = 0;

function record(entry) {
  if (process.env.FAKE_ANTHROPIC_LOG) appendFileSync(process.env.FAKE_ANTHROPIC_LOG, JSON.stringify(entry) + '\n');
}

function create(params, { signal } = {}) {
  const step = script[Math.min(calls, script.length - 1)] || {};
  calls += 1;
  const entry = { call: calls, maxTokens: params.max_tokens, answered: false, aborted: false };
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      entry.aborted = true;
      record(entry);
      reject(new APIUserAbortError('Request was aborted.'));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', stop);
      entry.answered = true;
      record(entry);
      resolve({ model: 'test-model', stop_reason: step.stop || 'end_turn', content: [{ type: 'text', text: step.text || '' }], usage: { input_tokens: step.input ?? 1000, output_tokens: step.output ?? 200 } });
    }, step.delayMs || 0);
    if (signal && signal.aborted) stop();
    else if (signal) signal.addEventListener('abort', stop, { once: true });
  });
}

export default class Anthropic {
  static APIError = APIError;
  static APIUserAbortError = APIUserAbortError;
  static AuthenticationError = AuthenticationError;
  static RateLimitError = RateLimitError;
  static APIConnectionError = APIConnectionError;

  constructor(options = {}) {
    this.options = options;
    this.messages = { create };
  }
}
