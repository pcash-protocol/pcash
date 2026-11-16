#!/usr/bin/env python3
"""Check the issuance policy with Python integers, sharing no code with Rust.

Recomputes every frozen vector, the ASERT fraction factor for all 65,536
inputs and the multiplier for every legal Q16 exponent, then reports the
approximation error against 2^x.
"""

import argparse
import hashlib
import json
import math
from collections import Counter
from decimal import ROUND_FLOOR, Decimal, getcontext
from pathlib import Path

Q = 1 << 128
T = 365 * 86_400
TAU = 12
H = 2 * 86_400
K = 3
L = 4 * 86_400
CAP = 1_000_000_000 * 10**18
RADIX = 65_536
EXPONENT_DIGEST = "9a0bd21cbae0e76629fc374e4e0ffadbba0db4204dd40749320601518346b7b4"
MAXIMUM_RELATIVE_ERROR = Decimal("0.00013")


def trunc_div(a, b):
    assert b > 0
    return a // b if a >= 0 else -((-a) // b)


def fraction_factor(frac):
    assert 0 <= frac < RADIX
    return ((195766423245049 * frac + 971821376 * frac**2 + 5127 * frac**3 + 2**47) >> 48) + RADIX


def multiplier_from_exponent(exponent):
    shift = exponent // RADIX
    scaled = Q * fraction_factor(exponent - shift * RADIX)
    scaled = scaled >> -shift if shift < 0 else scaled << shift
    return scaled >> 16


def multiplier(offer_lag):
    if offer_lag < -128 * H * Q:
        return 0
    return multiplier_from_exponent(trunc_div(offer_lag * RADIX, H * Q))


def terms(issued, lag, elapsed):
    if issued >= CAP:
        return dict(baseline=0, internalOffer=0, blockAllowance=0, maxSingleActionReward=0,
                    multiplierQ=0, rewardPossible=False, exhausted=True), lag, 0
    q = math.isqrt((CAP - issued) * Q * Q // CAP)
    base_q = 2 * CAP * TAU * q // T
    offer_lag = min(L * Q, lag + elapsed * Q)
    multiplier_q = multiplier(offer_lag)
    offer_q = base_q * multiplier_q // Q
    allowance_q = K * base_q
    baseline, offer, allowance = base_q // Q, offer_q // Q, allowance_q // Q
    maximum = min(offer, allowance, CAP - issued)
    return dict(baseline=baseline, internalOffer=offer, blockAllowance=allowance,
                maxSingleActionReward=maximum, multiplierQ=multiplier_q,
                rewardPossible=maximum > 0, exhausted=False), offer_lag, allowance_q


def progress(issued):
    if issued >= CAP: return T * Q
    return T * (Q - math.isqrt((CAP - issued) * Q * Q // CAP))


def check(row):
    issued, lag = int(row["parent"]["issuedSoFar"]), int(row["parent"]["lagQ"])
    elapsed, count = row["elapsedSeconds"], row["qualifyingActions"]
    quote, offer_lag, allowance_q = terms(issued, lag, elapsed)
    expected_quote = {key: (str(value) if isinstance(value, int) and not isinstance(value, bool) else value) for key, value in quote.items()}
    assert expected_quote == row["quote"], (row["name"], "quote", expected_quote, row["quote"])
    if quote["exhausted"]:
        next_issued, next_lag, reward, minted = CAP, lag, 0, 0
    elif count == 0:
        next_issued, next_lag, reward, minted = issued, offer_lag, 0, 0
    else:
        allowance_each = allowance_q // (count * Q)
        remaining_each = (CAP - issued) // count
        reward = min(quote["internalOffer"], allowance_each, remaining_each)
        minted = count * reward; next_issued = issued + minted
        next_lag = offer_lag - (progress(next_issued) - progress(issued))
    expected = {"issuedSoFar": str(next_issued), "lagQ": str(next_lag), "rewardEach": str(reward),
                "newIssuance": str(minted)}
    assert expected == row["result"], (row["name"], "settlement", expected, row["result"])


def check_fraction_factors():
    factors = [fraction_factor(frac) for frac in range(RADIX)]
    assert factors[0] == RADIX and factors[-1] == 2 * RADIX - 1
    assert all(RADIX <= a <= b < 2 * RADIX for a, b in zip(factors, factors[1:]))


def check_exponents(exact_fixed):
    """Every legal Q16 exponent: bounds, monotonicity, whole half-lives and digest.

    Also compares each output with floor(2^(exponent/65536) * Q), taken from
    `exact_fixed[frac] = floor(2^(frac/65536) * 2^200)`.
    """
    digest, buffer, previous = hashlib.sha256(), bytearray(), 0
    largest, tail = (0, None), Counter()
    for exponent in range(-128 * RADIX, 2 * RADIX + 1):
        value = multiplier_from_exponent(exponent)
        assert previous <= value <= Q << (L // H), exponent
        shift, frac = divmod(exponent, RADIX)
        if frac == 0:
            assert value == (Q >> -shift if shift < 0 else Q << shift), exponent
        ideal = exact_fixed[frac] >> (72 - shift)
        if abs(value - ideal) > largest[0]:
            largest = (abs(value - ideal), exponent)
        if ideal < RADIX:
            tail[value - ideal] += 1
        buffer += value.to_bytes(32, "big")
        if len(buffer) >= 1 << 22:
            digest.update(bytes(buffer)); buffer.clear()
        previous = value
    digest.update(bytes(buffer))
    assert digest.hexdigest() == EXPONENT_DIGEST, digest.hexdigest()
    return largest, tail


def error_report():
    getcontext().prec = 80
    ln2 = Decimal(2).ln()
    exact = [(ln2 * frac / RADIX).exp() for frac in range(RADIX)]
    kernel = [Decimal(fraction_factor(frac)) / RADIX - exact[frac] for frac in range(RADIX)]
    absolute = max(range(RADIX), key=lambda frac: abs(kernel[frac]))
    relative = max(range(RADIX), key=lambda frac: abs(kernel[frac] / exact[frac]))
    print(f"Fraction factor: max absolute error {abs(kernel[absolute]):.6e} at frac {absolute}; "
          f"max relative error {abs(kernel[relative] / exact[relative]) * 100:.10f}% at frac {relative}.")

    # Q128 lags within one unit of a Q16 quotient boundary b(k) = k*H*Q/65536,
    # for every k in [-128*65536, 2*65536]. For lag = b(k) + d, truncation
    # toward zero gives exponent e = k, except e = k + 1 when k < 0 and d = +1
    # and e = k - 1 when k > 0 and d = -1. The pre-floor approximation
    # (factor(e mod 65536) / 65536) * 2^floor(e/65536) over the ideal
    # 2^(lag/(H*Q)) is therefore
    #   factor(f) / 65536 / 2^(f/65536) * 2^((e-k)/65536) / 2^(d/(H*Q)),  f = e mod 65536,
    # which depends only on (f, e - k, d). Every such combination occurs in the
    # legal domain and neither side reaches the 4x cap, so enumerating the
    # combinations covers every boundary-adjacent lag.
    step, unit = (ln2 / RADIX).exp(), (ln2 / (H * Q)).exp()
    worst = (Decimal(0), None)
    for frac in range(RADIX):
        base = Decimal(fraction_factor(frac)) / RADIX / exact[frac]
        for offset, d in ((0, -1), (0, 0), (0, 1), (1, 1), (-1, -1)):
            error = abs(base * step**offset / unit**d - 1)
            if error > worst[0]:
                worst = (error, (frac, offset, d))
    error, (frac, offset, d) = worst
    exponent = frac - RADIX if (offset, d) in ((1, 1), (0, -1)) else frac
    k = exponent - offset
    lag = k * (H * Q // RADIX) + d
    assert trunc_div(lag * RADIX, H * Q) == exponent and multiplier(lag) == multiplier_from_exponent(exponent)
    print(f"Q128 lag to Q16 exponent: max relative error {error * 100:.10f}% at lag {lag} "
          f"({k}/65536 half-lives {d:+d}).")
    assert error < MAXIMUM_RELATIVE_ERROR, error
    return [int((value * (1 << 200)).to_integral_value(rounding=ROUND_FLOOR)) for value in exact]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vectors", type=Path)
    args = parser.parse_args()
    document = json.loads(args.vectors.read_text())
    assert int(document["supplyCap"]) == CAP and document["exponentRadix"] == RADIX
    for row in document["vectors"]: check(row)
    print(f"{len(document['vectors'])} vectors match Python integer settlement.")
    check_fraction_factors()
    exact_fixed = error_report()
    (difference, exponent), tail = check_exponents(exact_fixed)
    print(f"All {130 * RADIX + 1} Q16 exponents match digest 0x{EXPONENT_DIGEST}.")
    print(f"Largest |multiplierQ - floor(2^(e/65536) * Q)| is {difference} at exponent {exponent}; "
          f"where the ideal is below 65536, differences {dict(sorted(tail.items()))}.")


if __name__ == "__main__": main()
