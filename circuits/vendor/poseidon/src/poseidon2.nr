global RATE: u32 = 3;

pub struct Poseidon2 {}

impl Poseidon2 {
    #[no_predicates]
    pub fn hash<let N: u32>(input: [Field; N], message_size: u32) -> Field {
        Poseidon2::hash_internal(input, message_size)
    }

    fn hash_internal<let N: u32>(input: [Field; N], in_len: u32) -> Field {
        let two_pow_64 = 18446744073709551616;
        let iv: Field = (in_len as Field) * two_pow_64;
        let mut state = [0; 4];
        state[RATE] = iv;

        if std::runtime::is_unconstrained() {
            for i in 0..(in_len / RATE) {
                state[0] += input[i * RATE];
                state[1] += input[i * RATE + 1];
                state[2] += input[i * RATE + 2];
                state = crate::poseidon2_permutation(state);
            }

            // handle remaining elements after last full RATE-sized chunk
            let num_extra_fields = in_len % RATE;
            if num_extra_fields != 0 {
                let remainder_start = in_len - num_extra_fields;
                state[0] += input[remainder_start];
                if num_extra_fields > 1 {
                    state[1] += input[remainder_start + 1];
                }
            }
        } else {
            let mut states: [[Field; 4]; N / RATE + 1] = [[0; 4]; N / RATE + 1];
            states[0] = state;

            // process all full RATE-sized chunks, storing state after each permutation
            for chunk_idx in 0..(N / RATE) {
                for i in 0..RATE {
                    state[i] += input[chunk_idx * RATE + i];
                }
                state = crate::poseidon2_permutation(state);
                states[chunk_idx + 1] = state;
            }

            // get state at the last full block before in_len
            let first_partially_filled_chunk = in_len / RATE;
            state = states[first_partially_filled_chunk];

            // handle remaining elements after last full RATE-sized chunk
            let remainder_start = (in_len / RATE) * RATE;
            for j in 0..RATE {
                let idx = remainder_start + j;
                if idx < in_len {
                    state[j] += input[idx];
                }
            }
        }

        // always run final permutation unless we just completed a full chunk
        // still need to permute once if in_len is 0
        if (in_len == 0) | (in_len % RATE != 0) {
            state = crate::poseidon2_permutation(state);
        };

        state[0]
    }
}
