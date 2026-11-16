#[derive(Clone, Copy)]
pub(super) struct KnownAnswer {
    #[cfg(test)]
    pub(super) name: &'static str,
    pub(super) vk: &'static [u8],
    pub(super) proof: &'static [u8],
    pub(super) rejected_proof: &'static [u8],
    pub(super) public_inputs: &'static [u8],
    pub(super) valid_not_accepted: &'static str,
    pub(super) invalid_not_rejected: &'static str,
}

macro_rules! hiding_kernel_known_answer {
    ($constant:ident, $name:literal, $hiding_kernel:literal) => {
        pub(super) const $constant: KnownAnswer = KnownAnswer {
            #[cfg(test)]
            name: $name,
            vk: include_bytes!(concat!(
                env!("PCASH_CIRCUIT_BUNDLE"),
                "/vks/",
                $hiding_kernel,
                ".chonk.vk"
            )),
            proof: include_bytes!(concat!(
                env!("PCASH_CIRCUIT_BUNDLE"),
                "/known-answers/",
                $name,
                "/proof"
            )),
            rejected_proof: include_bytes!(concat!(
                env!("PCASH_CIRCUIT_BUNDLE"),
                "/known-answers/",
                $name,
                "/proof.rejected"
            )),
            public_inputs: include_bytes!(concat!(
                env!("PCASH_CIRCUIT_BUNDLE"),
                "/known-answers/",
                $name,
                "/public_inputs"
            )),
            valid_not_accepted: concat!($name, " valid proof was not accepted"),
            invalid_not_rejected: concat!(
                $name,
                " known-invalid proof was not a recognized rejection"
            ),
        };
    };
}
hiding_kernel_known_answer!(
    PRIVATE_VALUE_HIDING_KERNEL_KAT,
    "private_value",
    "private_value_hiding_kernel"
);
hiding_kernel_known_answer!(
    LARGE_PRIVATE_VALUE_HIDING_KERNEL_KAT,
    "private_value_large",
    "private_value_large_hiding_kernel"
);
hiding_kernel_known_answer!(
    USER_ACCOUNT_UPDATE_HIDING_KERNEL_KAT,
    "user_account_update",
    "user_account_update_hiding_kernel"
);

pub(super) const HIDING_KERNEL_KATS: [KnownAnswer; 3] = [
    PRIVATE_VALUE_HIDING_KERNEL_KAT,
    LARGE_PRIVATE_VALUE_HIDING_KERNEL_KAT,
    USER_ACCOUNT_UPDATE_HIDING_KERNEL_KAT,
];

/// Framed requests a fresh worker answers before it is trusted: a positive and
/// a negative known answer for every hiding-kernel verification key. Test
/// harnesses that stand in for `bb` script this prefix, so they track the KAT
/// set from here rather than repeating its size.
pub const STARTUP_KNOWN_ANSWER_REQUESTS: usize = HIDING_KERNEL_KATS.len() * 4;
