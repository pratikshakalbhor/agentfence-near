// One-off consistency check: decode the MPC `derived_public_key` (bs58
// compressed secp256k1 pubkey, returned by the view method) and derive the
// EVM address from it, comparing against the address printed by
// `derive-address.mjs`.
import { keccak256, getAddress, bytesToHex, hexToBytes } from 'viem';

const bs58 =
  '2xZ9d6TbjdRBVu34T47zmWSy1FTtXM2FmEDbbFuPjkteCC7oEcgCXZro6UzyX8zU4BXRhgjecxiYriwqtGdPUcM';
const ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

let n = 0n;
for (const c of bs58) {
  const i = ALPHABET.indexOf(c);
  if (i < 0) throw new Error(`bad bs58 char ${c}`);
  n = n * 58n + BigInt(i);
}
let hex = n.toString(16).padStart(66, '0');
if (hex.length % 2) hex = '0' + hex;
const bytes = Buffer.from(hex, 'hex');
if (bytes.length !== 64) throw new Error(`expected 64 raw x||y bytes, got ${bytes.length}`);

const address = getAddress(bytesToHex(hexToBytes(keccak256(bytes)).slice(-20)));

console.log(`on-chain derived address: ${address}`);
console.log(
  `matches derive-address.mjs: ${address.toLowerCase() === '0x44c8f698d9c2711925af1df0b9bb3d4b62e8ea57'}`,
);
