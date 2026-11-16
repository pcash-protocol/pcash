//! The byte cursor and [`Codec`] trait behind every hand-written binary
//! encoding: consensus values and the rows the node's stores persist.
//!
//! Integers are big-endian and fixed-width, hashes and addresses are their raw
//! bytes, a `bool` or `Option` flag is one byte that is `0` or `1`, a list is a
//! `u64` count followed by its items, and an enum is its tag followed by the
//! fields of the variant. Decoding is exact: every value has one byte string
//! and every accepted byte string one value.

use alloy_primitives::{Address, B256, I256, U256};
use pcash_crypto::Fr;
use std::fmt;

/// A read past the end of the input, or input left over after the value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorError {
    Truncated,
    Trailing,
    Overflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    Truncated,
    Trailing,
    Overflow,
    /// A flag or tag byte outside the values its type assigns.
    Invalid(&'static str),
}

impl From<CursorError> for DecodeError {
    fn from(error: CursorError) -> Self {
        match error {
            CursorError::Truncated => Self::Truncated,
            CursorError::Trailing => Self::Trailing,
            CursorError::Overflow => Self::Overflow,
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => f.write_str("truncated encoding"),
            Self::Trailing => f.write_str("trailing bytes after encoding"),
            Self::Overflow => f.write_str("length overflow"),
            Self::Invalid(what) => write!(f, "invalid {what}"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// A count or byte length that its wire prefix cannot represent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrefixOverflow {
    pub field: &'static str,
    pub max: usize,
    pub actual: usize,
}

/// The big-endian byte sink [`Reader`] reads back.
#[derive(Default)]
pub struct Writer {
    out: Vec<u8>,
}

impl Writer {
    pub fn into_bytes(self) -> Vec<u8> {
        self.out
    }

    pub fn bytes(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
    }

    pub fn u8(&mut self, value: u8) {
        self.out.push(value);
    }

    pub fn u16(&mut self, value: u16) {
        self.bytes(&value.to_be_bytes());
    }

    pub fn u32(&mut self, value: u32) {
        self.bytes(&value.to_be_bytes());
    }

    pub fn u64(&mut self, value: u64) {
        self.bytes(&value.to_be_bytes());
    }

    /// A count prefix: an error when `len` does not fit, never a wrapped
    /// value.
    pub fn len_u8(&mut self, field: &'static str, len: usize) -> Result<(), PrefixOverflow> {
        let prefix = u8::try_from(len).map_err(|_| PrefixOverflow {
            field,
            max: u8::MAX as usize,
            actual: len,
        })?;
        self.u8(prefix);
        Ok(())
    }
}

/// A forward-only byte cursor that rejects truncation and trailing bytes.
pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8], CursorError> {
        let end = self.pos.checked_add(n).ok_or(CursorError::Overflow)?;
        if end > self.data.len() {
            return Err(CursorError::Truncated);
        }
        let out = &self.data[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    pub fn take_array<const N: usize>(&mut self) -> Result<[u8; N], CursorError> {
        let s = self.take(N)?;
        let mut out = [0u8; N];
        out.copy_from_slice(s);
        Ok(out)
    }

    pub fn take_u8(&mut self) -> Result<u8, CursorError> {
        Ok(self.take(1)?[0])
    }

    pub fn take_u16(&mut self) -> Result<u16, CursorError> {
        Ok(u16::from_be_bytes(self.take_array()?))
    }

    pub fn take_u32(&mut self) -> Result<u32, CursorError> {
        Ok(u32::from_be_bytes(self.take_array()?))
    }

    pub fn take_u64(&mut self) -> Result<u64, CursorError> {
        Ok(u64::from_be_bytes(self.take_array()?))
    }

    pub fn finish(self) -> Result<(), CursorError> {
        if self.pos == self.data.len() {
            Ok(())
        } else {
            Err(CursorError::Trailing)
        }
    }
}

/// A type with exactly one byte encoding.
pub trait Codec: Sized {
    /// Append this value's encoding.
    fn write(&self, w: &mut Writer);

    /// Read one value, leaving the cursor after it.
    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError>;

    fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        self.write(&mut w);
        w.into_bytes()
    }

    /// Decode a byte string that is exactly one value.
    fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(bytes);
        let value = Self::read(&mut r)?;
        r.finish()?;
        Ok(value)
    }
}

impl Codec for u8 {
    fn write(&self, w: &mut Writer) {
        w.u8(*self);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(r.take_u8()?)
    }
}

impl Codec for u16 {
    fn write(&self, w: &mut Writer) {
        w.u16(*self);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(r.take_u16()?)
    }
}

impl Codec for u32 {
    fn write(&self, w: &mut Writer) {
        w.u32(*self);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(r.take_u32()?)
    }
}

impl Codec for u64 {
    fn write(&self, w: &mut Writer) {
        w.u64(*self);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(r.take_u64()?)
    }
}

impl Codec for bool {
    fn write(&self, w: &mut Writer) {
        w.u8(u8::from(*self));
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        match r.take_u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(DecodeError::Invalid("flag")),
        }
    }
}

impl Codec for B256 {
    fn write(&self, w: &mut Writer) {
        w.bytes(self.as_slice());
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(Self::from(r.take_array::<32>()?))
    }
}

impl Codec for Address {
    fn write(&self, w: &mut Writer) {
        w.bytes(self.as_slice());
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(Self::from(r.take_array::<20>()?))
    }
}

impl Codec for U256 {
    fn write(&self, w: &mut Writer) {
        w.bytes(&self.to_be_bytes::<32>());
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(Self::from_be_bytes(r.take_array::<32>()?))
    }
}

/// Two's complement.
impl Codec for I256 {
    fn write(&self, w: &mut Writer) {
        self.into_raw().write(w);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(Self::from_raw(U256::read(r)?))
    }
}

/// The canonical encoding only: a word at or above the modulus is rejected.
impl Codec for Fr {
    fn write(&self, w: &mut Writer) {
        crate::field::fr_to_bytes(*self).write(w);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        crate::field::fr_from_canonical_bytes(B256::read(r)?)
            .ok_or(DecodeError::Invalid("field element"))
    }
}

/// The elements alone: the length is the type's.
impl<const N: usize> Codec for [Fr; N] {
    fn write(&self, w: &mut Writer) {
        for item in self {
            item.write(w);
        }
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let mut items = [Fr::from(0u64); N];
        for item in &mut items {
            *item = Fr::read(r)?;
        }
        Ok(items)
    }
}

/// The bytes alone: the length is the type's.
impl<const N: usize> Codec for [u8; N] {
    fn write(&self, w: &mut Writer) {
        w.bytes(self);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(r.take_array()?)
    }
}

impl<T: Codec> Codec for Box<T> {
    fn write(&self, w: &mut Writer) {
        self.as_ref().write(w);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(Box::new(T::read(r)?))
    }
}

impl<T: Codec> Codec for Option<T> {
    fn write(&self, w: &mut Writer) {
        self.is_some().write(w);
        if let Some(value) = self {
            value.write(w);
        }
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(if bool::read(r)? {
            Some(T::read(r)?)
        } else {
            None
        })
    }
}

/// The encoding of a `Vec` of `items`, without collecting one.
pub fn encode_list<'a, T: Codec + 'a>(
    items: impl IntoIterator<Item = &'a T, IntoIter: ExactSizeIterator>,
) -> Vec<u8> {
    let mut w = Writer::default();
    write_list(items, &mut w);
    w.into_bytes()
}

fn write_list<'a, T: Codec + 'a>(
    items: impl IntoIterator<Item = &'a T, IntoIter: ExactSizeIterator>,
    w: &mut Writer,
) {
    let items = items.into_iter();
    w.u64(items.len() as u64);
    for item in items {
        item.write(w);
    }
}

impl<T: Codec> Codec for Vec<T> {
    fn write(&self, w: &mut Writer) {
        write_list(self, w);
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let count = r.take_u64()?;
        let mut items = Self::new();
        for _ in 0..count {
            items.push(T::read(r)?);
        }
        Ok(items)
    }
}

/// [`Codec`] for a struct: its fields in the listed order.
#[macro_export]
macro_rules! codec_struct {
    ($ty:ty { $($field:ident),+ $(,)? }) => {
        impl $crate::codec::Codec for $ty {
            fn write(&self, w: &mut $crate::codec::Writer) {
                $($crate::codec::Codec::write(&self.$field, w);)+
            }

            fn read(
                r: &mut $crate::codec::Reader<'_>,
            ) -> Result<Self, $crate::codec::DecodeError> {
                Ok(Self {
                    $($field: $crate::codec::Codec::read(r)?,)+
                })
            }
        }
    };
}

/// [`Codec`] for a fieldless enum: its discriminant as `$tag`.
#[macro_export]
macro_rules! codec_enum {
    ($ty:ty: $tag:ty { $($variant:ident),+ $(,)? }) => {
        impl $crate::codec::Codec for $ty {
            fn write(&self, w: &mut $crate::codec::Writer) {
                $crate::codec::Codec::write(&(*self as $tag), w);
            }

            fn read(
                r: &mut $crate::codec::Reader<'_>,
            ) -> Result<Self, $crate::codec::DecodeError> {
                let tag = <$tag as $crate::codec::Codec>::read(r)?;
                $(if tag == Self::$variant as $tag {
                    return Ok(Self::$variant);
                })+
                Err($crate::codec::DecodeError::Invalid(stringify!($ty)))
            }
        }
    };
}

/// [`Codec`] for an enum of struct variants: `$tag`, then the variant's fields
/// in the listed order.
#[macro_export]
macro_rules! codec_variants {
    ($ty:ty: $tag:ty { $($value:expr => $variant:ident { $($field:ident),+ $(,)? }),+ $(,)? }) => {
        impl $crate::codec::Codec for $ty {
            fn write(&self, w: &mut $crate::codec::Writer) {
                match self {
                    $(Self::$variant { $($field),+ } => {
                        let tag: $tag = $value;
                        $crate::codec::Codec::write(&tag, w);
                        $($crate::codec::Codec::write($field, w);)+
                    })+
                }
            }

            fn read(
                r: &mut $crate::codec::Reader<'_>,
            ) -> Result<Self, $crate::codec::DecodeError> {
                let tag = <$tag as $crate::codec::Codec>::read(r)?;
                $(if tag == $value {
                    return Ok(Self::$variant {
                        $($field: $crate::codec::Codec::read(r)?,)+
                    });
                })+
                Err($crate::codec::DecodeError::Invalid(stringify!($ty)))
            }
        }
    };
}

pub use {codec_enum, codec_struct, codec_variants};
