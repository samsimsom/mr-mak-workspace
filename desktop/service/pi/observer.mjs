// Loaded inside Pi through its extension API. Observe native events only; never
// intercept a prompt, request a model, change tools, or read provider credentials.
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// Pi's own rule for --session-id (assertValidSessionId in session-manager).
export const validSessionId = value => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);

// Events are reduced to plain objects so the state machine is testable without Pi:
// { type: 'session', id } · 'agent_start' · { type: 'message_end', role, stopReason }
// { type: 'turn_end', role, stopReason, entryId } · 'ui_prompt_start' · 'ui_prompt_end'
// { type: 'agent_settled', aborted }
export function createObserver({ nativeId, chatId, launchId, save }) {
  let state = { chatId, launchId, nativeId: validSessionId(nativeId) ? nativeId : null, activity: 'idle', completion: null, revision: 0 };
  let running = false, prompts = 0, stopReason = null, entryId = null, turns = 0;
  const emit = patch => { state = { ...state, ...patch, revision: state.revision + 1 }; save({ ...state }); };
  const reset = () => { running = false; prompts = 0; stopReason = null; entryId = null; };
  return event => {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'session') {
      // /new, /resume and /fork switch the terminal to another native session.
      if (!validSessionId(event.id) || event.id === state.nativeId) return;
      reset(); emit({ nativeId: event.id, activity: 'idle' });
    } else if (!state.nativeId) {
      return;
    } else if (event.type === 'agent_start') {
      running = true; stopReason = null; entryId = null;
      if (state.activity !== 'working') emit({ activity: 'working' });
    } else if (event.type === 'message_end' || event.type === 'turn_end') {
      if (event.role !== 'assistant') return;
      if (typeof event.stopReason === 'string') stopReason = event.stopReason;
      if (typeof event.entryId === 'string' && event.entryId) entryId = event.entryId;
    } else if (event.type === 'ui_prompt_start') {
      prompts++;
      if (state.activity !== 'waiting') emit({ activity: 'waiting' });
    } else if (event.type === 'ui_prompt_end') {
      prompts = Math.max(0, prompts - 1);
      const next = running ? 'working' : 'idle';
      if (!prompts && state.activity !== next) emit({ activity: next });
    } else if (event.type === 'agent_settled') {
      if (!running) return;
      const aborted = typeof event.aborted === 'boolean' ? event.aborted : stopReason === 'aborted';
      const failed = !aborted && stopReason === 'error';
      turns++;
      const id = entryId || `${launchId}:${turns}`;
      reset();
      // A provider error after Pi's own retries needs the user; an Escape does not.
      if (aborted) emit({ activity: 'idle' });
      else if (failed) emit({ activity: 'waiting' });
      else if (state.completion !== id) emit({ activity: 'idle', completion: id });
    }
  };
}

export function observerFromEnvironment(env = process.env) {
  const file = env.MRMAK_PI_STATE;
  if (!file || !path.isAbsolute(file) || !env.MRMAK_PI_CHAT_ID || !env.MRMAK_PI_LAUNCH_ID) return null;
  return createObserver({
    nativeId: env.MRMAK_PI_SESSION_ID, chatId: env.MRMAK_PI_CHAT_ID, launchId: env.MRMAK_PI_LAUNCH_ID,
    save(state) {
      try {
        writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
        renameSync(file + '.tmp', file);
      } catch { /* A stopped host must never break the user's native CLI. */ }
    },
  });
}
