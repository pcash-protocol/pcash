"""Generate the guest's bb inputs from bb's pinned source.

    prepare.py verifier <bb src> <out>             bb's native Chonk verifier
    prepare.py grumpkin-chunk <bb src>             the Grumpkin CRS's URL and its first chunk's byte range
    prepare.py crs <bb src> <chunk> <out dir>      the reference strings, in bb's in-memory layout

<bb src> is aztec-packages' barretenberg/cpp/src; <chunk> is the first chunk
of the Grumpkin CRS, which bb pins by SHA-256.
"""

import hashlib
import re
import sys
from pathlib import Path

# BN254's base field, and Grumpkin's (BN254's scalar field).
BN254_FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583
GRUMPKIN_FQ = 21888242871839275222246405745257275088548364400416034343698204186575808495617
GRUMPKIN_CRS_URL = "https://crs.aztec-cdn.foundation/grumpkin_g1_v2.dat"


def verifier(bb: Path, out: Path) -> None:
    """chonk/chonk_verifier.cpp without its in-circuit specialisations, so linking it
    does not pull in bb's circuit builders."""
    source = (bb / "barretenberg/chonk/chonk_verifier.cpp").read_text()
    cut = source.index("/**\n * @brief Verifies a Chonk IVC proof in-circuit.")
    native = source[:cut].replace('#include "chonk_verifier.hpp"', '#include "barretenberg/chonk/chonk_verifier.hpp"')
    out.write_text(native + "template class ChonkVerifier<false>;\n} // namespace bb\n")


def bytes_in(text: str, name: str) -> bytes:
    """The hex bytes of the C++ array initializer `name = { ... };`."""
    block = re.search(re.escape(name) + r"\s*=\s*\{(.*?)\};", text, re.S)
    return bytes(int(byte, 16) for byte in re.findall(r"0x([0-9a-fA-F]{2})", block.group(1)))


def montgomery(value: int, modulus: int) -> bytes:
    """A field element as bb holds it: Montgomery form, little-endian limbs."""
    return (value * (1 << 256) % modulus).to_bytes(32, "little")


def point(encoded: bytes, modulus: int) -> bytes:
    """A big-endian affine point (x ‖ y, or a G2 point's four coordinates) in bb's layout."""
    return b"".join(montgomery(int.from_bytes(encoded[i:i + 32], "big"), modulus) for i in range(0, len(encoded), 32))


def grumpkin_crs_data(bb: Path) -> str:
    return (bb / "barretenberg/srs/factories/grumpkin_crs_data.hpp").read_text()


def grumpkin_chunk(bb: Path) -> None:
    data = grumpkin_crs_data(bb)
    num_chunks = int(re.search(r"GRUMPKIN_G1_NUM_CHUNKS\s*=\s*(\d+)", data).group(1))
    num_points = 1 << int(re.search(r"GRUMPKIN_G1_NUM_POINTS\s*=\s*1ULL\s*<<\s*(\d+)", data).group(1))
    print(GRUMPKIN_CRS_URL, f"0-{num_points // num_chunks * 64 - 1}")


def crs(bb: Path, chunk_file: Path, out: Path) -> None:
    bn254 = (bb / "barretenberg/srs/factories/bn254_crs_data.hpp").read_text()
    constants = (bb / "barretenberg/constants.hpp").read_text()

    # The ECCVM's IPA opens 2^CONST_ECCVM_LOG_N Grumpkin points, a prefix of the
    # first chunk.
    chunk = chunk_file.read_bytes()
    if hashlib.sha256(chunk).digest() != bytes_in(grumpkin_crs_data(bb), "GRUMPKIN_G1_CHUNK_HASHES")[:32]:
        sys.exit(f"{chunk_file}: not the Grumpkin CRS's first chunk that bb pins")
    log_n = int(re.search(r"CONST_ECCVM_LOG_N\s*=\s*(\d+)", constants).group(1))
    grumpkin_points = b"".join(point(chunk[i:i + 64], GRUMPKIN_FQ) for i in range(0, (1 << log_n) * 64, 64))

    # BN254's first G1 point is the generator (1, 2); [x]_2 is bb's pinned constant.
    g2 = bytes_in(bn254, "BN254_G2_ELEMENT_BYTES")
    out.mkdir(parents=True, exist_ok=True)
    (out / "grumpkin.bin").write_bytes(grumpkin_points)
    (out / "bn254_g1.bin").write_bytes(montgomery(1, BN254_FQ) + montgomery(2, BN254_FQ))
    (out / "bn254_g2.bin").write_bytes(point(g2, BN254_FQ))


if __name__ == "__main__":
    command = {"verifier": verifier, "grumpkin-chunk": grumpkin_chunk, "crs": crs}[sys.argv[1]]
    command(*map(Path, sys.argv[2:]))
