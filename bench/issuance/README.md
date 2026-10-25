# Issuance conformance

The selected bounded-memory ASERT policy has no parameter sweep in this repository. Consensus arithmetic is pinned by exact vectors checked through independent Rust and Python-integer paths.

```sh
cargo run --locked -p pcash-issuance --bin issuance-vectors -- --check vectors/issuance.json
just test-issuance-python
```

Generate a candidate vector file with `issuance-vectors --write PATH`, then review it and run both checks before replacing the checked-in fixture.

The Python check uses only the standard library. It also evaluates every legal Q16 exponent against its digest and reports the multiplier's error against `2^x`.
