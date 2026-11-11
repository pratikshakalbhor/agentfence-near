// Apply logic shared by the CLI and the tests. Pure given the injected
// runners — no network unless the caller wires one in.
import {
  buildOwnerCommands,
  renderNearCommand,
  type OwnerCommand,
  type PolicyFile,
} from './policy.js';

export async function applyPolicy(params: {
  policy: PolicyFile;
  dryRun: boolean;
  runCommand: (command: OwnerCommand, policy: PolicyFile) => Promise<void>;
  checkAllowed: (
    contract: string,
    agent: string,
    destination: string,
  ) => Promise<boolean>;
}): Promise<void> {
  const { policy } = params;
  const toAdd: string[] = [];
  for (const dest of policy.allowlist) {
    const ok = await params.checkAllowed(
      policy.contract,
      policy.agent,
      dest,
    );
    if (ok) {
      console.log(`  skip (already allowed): ${dest}`);
    } else {
      toAdd.push(dest);
    }
  }
  const commands = buildOwnerCommands(policy, toAdd);
  if (params.dryRun) {
    for (const command of commands) {
      console.log(
        `  [dry-run] ${renderNearCommand(policy.contract, policy.owner, command)}`,
      );
    }
    return;
  }
  for (const command of commands) {
    console.log(`  > ${command.description}`);
    await params.runCommand(command, policy);
  }
}
