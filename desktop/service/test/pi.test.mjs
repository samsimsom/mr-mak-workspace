import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createObserver, validSessionId } from '../pi/observer.mjs';
import mrmakObserver from '../pi/mrmak-observer.mjs';
import { piEnvironment, piExtension, piStatePath, readPiState } from '../pi.mjs';
import { childEnvironment, terminalCommand } from '../agents.mjs';
import { Sessions } from '../sessions.mjs';

const id = '019a2f6c-1111-7222-8333-444455556666';
function observer(nativeId = id) {
  const states = [];
  const send = createObserver({ nativeId, chatId: 'chat-a', launchId: 'launch-a', save: state => states.push(state) });
  return { send, states, state: () => states.at(-1) };
}
const withPath = async (bin, run) => {
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (previous || '');
  try { return await run(); } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
};

test('Pi session IDs follow Pi\'s own --session-id rule', () => {
  for (const value of [id, 'a', 'release.1_b-2']) assert.equal(validSessionId(value), true);
  for (const value of ['', '-a', 'a-', '.a', 'a:b', 'a b', '--yolo', 'a'.repeat(129), 7, null]) assert.equal(validSessionId(value), false);
});

test('the Pi observer reports work, final answers, prompts, errors and interruptions', () => {
  const { send, states, state } = observer();
  send({ type: 'session', id });
  assert.equal(states.length, 0, 'the assigned session needs no write');
  send({ type: 'agent_start' });
  assert.equal(state().activity, 'working');
  send({ type: 'message_end', role: 'assistant', stopReason: 'toolUse' });
  send({ type: 'ui_prompt_start' });
  assert.equal(state().activity, 'waiting');
  send({ type: 'ui_prompt_end' });
  assert.equal(state().activity, 'working');
  send({ type: 'message_end', role: 'assistant', stopReason: 'stop' });
  send({ type: 'turn_end', role: 'assistant', stopReason: 'stop', entryId: 'entry-1' });
  send({ type: 'agent_settled', aborted: false });
  assert.deepEqual([state().activity, state().completion], ['idle', 'entry-1']);
  send({ type: 'agent_settled', aborted: false });
  assert.equal(states.length, 4, 'a settled run is reported once');

  send({ type: 'agent_start' });
  send({ type: 'message_end', role: 'assistant', stopReason: 'aborted' });
  send({ type: 'agent_settled', aborted: true });
  assert.deepEqual([state().activity, state().completion], ['idle', 'entry-1']);

  send({ type: 'agent_start' });
  send({ type: 'message_end', role: 'assistant', stopReason: 'error' });
  send({ type: 'agent_settled', aborted: false });
  assert.deepEqual([state().activity, state().completion], ['waiting', 'entry-1']);

  // Older Pi versions send no aborted flag or entry ID.
  send({ type: 'agent_start' });
  send({ type: 'message_end', role: 'assistant', stopReason: 'aborted' });
  send({ type: 'agent_settled' });
  assert.equal(state().activity, 'idle');
  send({ type: 'agent_start' });
  send({ type: 'message_end', role: 'assistant', stopReason: 'stop' });
  send({ type: 'agent_settled' });
  assert.equal(state().completion, 'launch-a:5');
  for (const state of states) assert.deepEqual([state.chatId, state.launchId, state.nativeId], ['chat-a', 'launch-a', id]);
});

test('the Pi observer follows /new and ignores invalid sessions and events before one', () => {
  const { send, states, state } = observer(null);
  send({ type: 'agent_start' });
  send({ type: 'session', id: '--bad' });
  assert.equal(states.length, 0);
  send({ type: 'session', id });
  assert.equal(state().nativeId, id);
  send({ type: 'agent_start' });
  send({ type: 'session', id: 'next-session' });
  assert.deepEqual([state().nativeId, state().activity], ['next-session', 'idle']);
  send({ type: 'agent_settled', aborted: false });
  assert.equal(state().completion, null, 'a run of the previous session does not complete the new one');
});

test('the Pi extension writes a private state file only when Mr. Mak launched it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mrmak-pi-extension-'));
  const file = path.join(dir, 'pi-chat-a.json');
  const keys = ['MRMAK_PI_STATE', 'MRMAK_PI_CHAT_ID', 'MRMAK_PI_LAUNCH_ID', 'MRMAK_PI_SESSION_ID'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const load = () => { const handlers = {}; mrmakObserver({ on: (name, handler) => { (handlers[name] ||= []).push(handler); } }); return handlers; };
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(load(), {}, 'outside Mr. Mak the extension registers nothing');
    Object.assign(process.env, { MRMAK_PI_STATE: file, MRMAK_PI_CHAT_ID: 'chat-a', MRMAK_PI_LAUNCH_ID: 'launch-a', MRMAK_PI_SESSION_ID: id });
    const handlers = load();
    const fire = (name, event, ctx) => handlers[name].forEach(handler => handler(event, ctx));
    fire('session_start', { type: 'session_start', reason: 'new' }, { sessionManager: { getSessionId: () => 'other-session' } });
    fire('agent_start', { type: 'agent_start' });
    fire('message_end', { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    fire('turn_end', { type: 'turn_end', message: { role: 'assistant', stopReason: 'stop' }, messageEntryId: 'entry-9' });
    fire('agent_settled', { type: 'agent_settled', aborted: false });
    const state = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual([state.nativeId, state.activity, state.completion], ['other-session', 'idle', 'entry-9']);
    if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(file).mode & 0o777, 0o600);
    assert.equal((await readPiState(dir, 'chat-a')).completion, 'entry-9');
    assert.equal(await readPiState(dir, 'chat-b'), null);
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test('Pi launch flags load the observer, keep the session and pass reasoning only when chosen', async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'mrmak-pi-bin-'));
  await writeFile(path.join(bin, process.platform === 'win32' ? 'pi.cmd' : 'pi'), '', { mode: 0o755 });
  await withPath(bin, () => {
    const text = command => process.platform === 'win32' ? Buffer.from(command.args.at(-1), 'base64').toString('utf16le') : command.args.join(' ');
    for (const bypass of [false, true]) {
      const launch = text(terminalCommand('pi', { bypass, nativeId: id, effort: 'xhigh' }));
      assert.ok(launch.includes(`--extension ${piExtension}`));
      assert.ok(launch.includes(`--session-id ${id}`));
      assert.ok(launch.includes('--thinking xhigh'));
      assert.doesNotMatch(launch, /--yolo|--auto|dangerously|--approve/);
    }
    const resumed = text(terminalCommand('pi', { resumeId: 'release.1', nativeId: id }));
    assert.ok(resumed.includes('--session-id release.1')); assert.ok(!resumed.includes(id));
    assert.doesNotMatch(text(terminalCommand('pi', { nativeId: id })), /--thinking/);
    assert.throws(() => terminalCommand('pi', { resumeId: 'a:b' }), /Pi session ID/);
    assert.throws(() => terminalCommand('pi', { initialPrompt: 'Hello' }), /first message|Only a new/);
  });
});

test('Pi state and identity variables never leak into another terminal', () => {
  const env = piEnvironment({ KEEP: '1' }, { stateDir: '/tmp/state', session: { id: 'chat-a', nativeId: id }, launchId: 'launch-a' });
  assert.deepEqual([env.KEEP, env.MRMAK_PI_STATE, env.MRMAK_PI_SESSION_ID, env.MRMAK_PI_LAUNCH_ID], ['1', piStatePath('/tmp/state', 'chat-a'), id, 'launch-a']);
  assert.throws(() => piEnvironment({}, { stateDir: '/tmp/state', session: { id: 'chat-a', nativeId: '--bad' } }));
  const names = ['AI_AGENT', 'PI_CODING_AGENT', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL', 'MRMAK_PI_STATE'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  try {
    for (const key of names) process.env[key] = 'x';
    process.env.PI_CODING_AGENT_DIR_KEEP_TEST = 'kept';
    const child = childEnvironment();
    for (const key of names) assert.equal(child[key], undefined, key);
    assert.equal(child.PI_CODING_AGENT_DIR_KEEP_TEST, 'kept');
  } finally {
    delete process.env.PI_CODING_AGENT_DIR_KEEP_TEST;
    for (const key of names) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test('a Pi chat gets its session ID before launch, follows /new and resumes that session after restart', { skip: process.platform === 'win32' && 'uses a /bin/sh shim' }, async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'mrmak-pi-flow-'));
  const repo = path.join(sandbox, 'project'), stateDir = path.join(sandbox, 'state'), bin = path.join(sandbox, 'bin');
  await Promise.all([mkdir(repo), mkdir(stateDir), mkdir(bin)]);
  const log = path.join(sandbox, 'launches.log');
  // Stands in for Pi plus the extension: the first launch switches to a new session with /new and answers.
  await writeFile(path.join(bin, 'pi'), `#!/bin/sh
printf "%s\\n" "$*" >> "${log}"
if [ ! -f "${log}.once" ]; then : > "${log}.once"; printf '{"chatId":"%s","launchId":"%s","nativeId":"after-new","activity":"idle","completion":"entry-1","revision":1}' "$MRMAK_PI_CHAT_ID" "$MRMAK_PI_LAUNCH_ID" > "$MRMAK_PI_STATE"; fi
sleep 0.6
`);
  await chmod(path.join(bin, 'pi'), 0o755);
  let sessions, restored;
  await withPath(bin, async () => {
    try {
      sessions = await new Sessions(repo, stateDir).init();
      const created = await sessions.create({ agent: 'pi', name: 'Pi Flow', cwd: repo, bypass: true });
      const original = sessions.get(created.id);
      assert.equal(created.bypass, false, 'Pi has no permission prompts to bypass');
      assert.equal(created.effort, undefined, 'Pi keeps its own thinking default');
      assert.match(created.nativeId, /^[0-9a-f-]{36}$/);
      const assigned = created.nativeId;
      for (let i = 0; i < 40 && original.nativeId === assigned; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(original.nativeId, 'after-new');
      for (let i = 0; i < 40 && original.lastCompletedId !== 'entry-1'; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(original.lastCompletedId, 'entry-1');
      assert.equal(original.unread, true);
      for (let i = 0; i < 60 && original.process; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(original.process, null);
      await sessions.close();

      restored = await new Sessions(repo, stateDir).init();
      await restored.resume(created.id);
      const resumed = restored.get(created.id);
      assert.equal(resumed.nativeId, 'after-new');
      for (let i = 0; i < 60 && resumed.process; i++) await new Promise(resolve => setTimeout(resolve, 50));
      const launches = (await readFile(log, 'utf8')).trim().split('\n');
      assert.equal(launches.length, 2);
      assert.ok(launches[0].includes(`--session-id ${assigned}`));
      assert.ok(launches[1].includes('--session-id after-new'));
      for (const launch of launches) assert.ok(launch.includes(`--extension ${piExtension}`));
    } finally {
      await sessions?.close();
      await restored?.close();
    }
  });
});
