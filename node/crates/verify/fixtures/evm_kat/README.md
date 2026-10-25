# EVM hiding-kernel known answers

The circuit-bundle generator creates a positive proof, a negative, public inputs, and VK for every hiding kernel. The negative flips the low bit of the proof's last scalar, which precedes the final Shplonk Q and KZG W commitments, so it decompresses and is rejected by `ChonkVerify` itself; generation fails otherwise. The node embeds those files from the active content-addressed bundle and requires the positive proof to verify and the negative proof to fail before opening state.

Run the structural check against the active bundle with:

```sh
node scripts/circuits/bundle.mjs exec -- node node/crates/verify/fixtures/evm_kat/check.mjs
```

The release gate additionally runs both cases through the pinned Barretenberg binary. No generated known-answer bytes or digests are committed in this directory.
