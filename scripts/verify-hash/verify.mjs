// Independent verification: build the same unsigned Sepolia EIP-1559 tx with
// viem and print its signing hash (keccak256 of the unsigned serialized tx).
import { serializeTransaction, keccak256 } from 'viem';

const unsigned = serializeTransaction({
  type: 'eip1559',
  chainId: 11155111,
  nonce: 7,
  to: '0x1111111111111111111111111111111111111111',
  value: 50n,
  data: '0x',
  maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 1000000000n,
  gas: 21000n,
});

console.log('unsigned_tx:', unsigned);
console.log('signing_hash:', keccak256(unsigned));
