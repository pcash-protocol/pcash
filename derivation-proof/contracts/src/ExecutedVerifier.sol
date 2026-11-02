// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ISP1Verifier} from "@sp1-contracts/src/ISP1Verifier.sol";

/// Stands in for SP1's verifier in development. The proof is the public values
/// the aggregation program committed when SP1's executor ran it, so the
/// contract's claim must equal the program's output, though nothing proves the
/// program ran.
contract ExecutedVerifier is ISP1Verifier {
    error PublicValuesMismatch();

    function verifyProof(bytes32, bytes calldata publicValues, bytes calldata proofBytes) external pure {
        if (keccak256(publicValues) != keccak256(proofBytes)) revert PublicValuesMismatch();
    }
}
