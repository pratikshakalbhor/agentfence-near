// agentKeyFile (typically AGENT_FCK_KEY_FILE=~/…) may use a leading "~";
// it must be expanded to os.homedir() before the key file is read.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn() };
});

import { readFile } from 'node:fs/promises';
import { AgentFence } from '../src/index.js';

const KEY = 'ed25519:dummy-test-key';

const readMock = readFile as unknown as {
  mockReset(): void;
  mockResolvedValue(v: unknown): void;
};

function makeClient(agentKeyFile: string): AgentFence {
  return new AgentFence({
    network: 'testnet',
    contractAccount: 'agentfence-contract-evm-0b497ae1.testnet',
    agentAccount: 'agentfence-agent-9a9635f2.testnet',
    agentKeyFile,
  });
}

async function resolveKey(client: AgentFence): Promise<string> {
  return (client as unknown as { resolveFckKey(): Promise<string> }).resolveFckKey();
}

beforeEach(() => {
  readMock.mockReset();
  readMock.mockResolvedValue(JSON.stringify({ secret_key: KEY }));
});

describe('agentKeyFile home expansion', () => {
  it('expands "~/…" (AGENT_FCK_KEY_FILE style) to os.homedir() before reading', async () => {
    const key = await resolveKey(
      makeClient('~/.near-credentials/agentfence-agent-fck-evm.txt'),
    );
    expect(readFile).toHaveBeenCalledWith(
      join(homedir(), '.near-credentials', 'agentfence-agent-fck-evm.txt'),
      'utf8',
    );
    expect(key).toBe(KEY);
  });

  it('expands a bare "~" to the home directory', async () => {
    await resolveKey(makeClient('~'));
    expect(readFile).toHaveBeenCalledWith(homedir(), 'utf8');
  });

  it('leaves absolute paths untouched', async () => {
    const abs = join(homedir(), 'keys', 'fck.txt');
    await resolveKey(makeClient(abs));
    expect(readFile).toHaveBeenCalledWith(abs, 'utf8');
  });

  it('leaves relative paths untouched', async () => {
    await resolveKey(makeClient('keys/fck.txt'));
    expect(readFile).toHaveBeenCalledWith('keys/fck.txt', 'utf8');
  });

  it('leaves "~user/…" untouched (not a home shorthand)', async () => {
    await resolveKey(makeClient('~other/.near-credentials/k.txt'));
    expect(readFile).toHaveBeenCalledWith('~other/.near-credentials/k.txt', 'utf8');
  });
});
