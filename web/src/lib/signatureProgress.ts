import type { PcashActionSigner } from "@pcash/sdk/eip712";

export function withSignatureProgress(
  signer: PcashActionSigner,
  start: () => () => void,
): PcashActionSigner {
  return {
    address: signer.address,
    async signTypedData(request) {
      const finish = start();
      try {
        return await signer.signTypedData(request);
      } finally {
        finish();
      }
    },
  };
}
