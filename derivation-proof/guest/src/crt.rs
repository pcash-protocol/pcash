//! Minimal C runtime for newlib + libstdc++ in the SP1 guest: malloc family on
//! the Rust allocator, and the newlib syscall stubs bb can reach.
use core::ffi::c_void;
use std::alloc::{alloc, alloc_zeroed, dealloc, Layout};

const HDR: usize = 16;

unsafe fn raw_alloc(size: usize, align: usize, zero: bool) -> *mut c_void {
    let align = align.max(HDR);
    let total = size + align;
    let layout = Layout::from_size_align_unchecked(total, align);
    let base = if zero { alloc_zeroed(layout) } else { alloc(layout) };
    if base.is_null() {
        return core::ptr::null_mut();
    }
    let user = base.add(align);
    // Header just below the user pointer: total size and alignment.
    *(user.sub(16) as *mut usize) = total;
    *(user.sub(8) as *mut usize) = align;
    user as *mut c_void
}

#[no_mangle]
pub unsafe extern "C" fn malloc(size: usize) -> *mut c_void {
    raw_alloc(size, HDR, false)
}
#[no_mangle]
pub unsafe extern "C" fn calloc(n: usize, size: usize) -> *mut c_void {
    raw_alloc(n.saturating_mul(size), HDR, true)
}
#[no_mangle]
pub unsafe extern "C" fn free(p: *mut c_void) {
    if p.is_null() {
        return;
    }
    let user = p as *mut u8;
    let total = *(user.sub(16) as *const usize);
    let align = *(user.sub(8) as *const usize);
    dealloc(user.sub(align), Layout::from_size_align_unchecked(total, align));
}
#[no_mangle]
pub unsafe extern "C" fn realloc(p: *mut c_void, size: usize) -> *mut c_void {
    if p.is_null() {
        return malloc(size);
    }
    let user = p as *mut u8;
    let total = *(user.sub(16) as *const usize);
    let align = *(user.sub(8) as *const usize);
    let old = total - align;
    let q = raw_alloc(size, align, false);
    if !q.is_null() {
        core::ptr::copy_nonoverlapping(user, q as *mut u8, old.min(size));
        free(p);
    }
    q
}
#[no_mangle]
pub unsafe extern "C" fn aligned_alloc(align: usize, size: usize) -> *mut c_void {
    raw_alloc(size, align, false)
}
#[no_mangle]
pub unsafe extern "C" fn memalign(align: usize, size: usize) -> *mut c_void {
    raw_alloc(size, align, false)
}
#[no_mangle]
pub unsafe extern "C" fn posix_memalign(out: *mut *mut c_void, align: usize, size: usize) -> i32 {
    let p = raw_alloc(size, align, false);
    *out = p;
    if p.is_null() { 12 } else { 0 }
}
// newlib's reentrant entry points.
#[no_mangle]
pub unsafe extern "C" fn _malloc_r(_r: *mut c_void, size: usize) -> *mut c_void {
    malloc(size)
}
#[no_mangle]
pub unsafe extern "C" fn _free_r(_r: *mut c_void, p: *mut c_void) {
    free(p)
}
#[no_mangle]
pub unsafe extern "C" fn _calloc_r(_r: *mut c_void, n: usize, s: usize) -> *mut c_void {
    calloc(n, s)
}
#[no_mangle]
pub unsafe extern "C" fn _realloc_r(_r: *mut c_void, p: *mut c_void, s: usize) -> *mut c_void {
    realloc(p, s)
}
#[no_mangle]
pub unsafe extern "C" fn _memalign_r(_r: *mut c_void, a: usize, s: usize) -> *mut c_void {
    memalign(a, s)
}

#[no_mangle]
pub unsafe extern "C" fn _sbrk(_incr: isize) -> *mut c_void {
    panic!("_sbrk called");
}
#[no_mangle]
pub unsafe extern "C" fn _write(fd: i32, buf: *const u8, n: usize) -> isize {
    sp1_zkvm::syscalls::syscall_write(fd as u32, buf, n);
    n as isize
}
#[no_mangle]
pub unsafe extern "C" fn _read(_fd: i32, _buf: *mut u8, _n: usize) -> isize {
    0
}
#[no_mangle]
pub extern "C" fn _close(_fd: i32) -> i32 {
    -1
}
#[no_mangle]
pub extern "C" fn _lseek(_fd: i32, _o: isize, _w: i32) -> isize {
    0
}
/// No file metadata: newlib's stdio then buffers with its defaults.
#[no_mangle]
pub extern "C" fn _fstat(_fd: i32, _st: *mut u8) -> i32 {
    -1
}
#[no_mangle]
pub extern "C" fn _isatty(_fd: i32) -> i32 {
    1
}
#[no_mangle]
pub extern "C" fn _getpid() -> i32 {
    1
}
#[no_mangle]
pub extern "C" fn _kill(_p: i32, _s: i32) -> i32 {
    panic!("_kill called (abort)");
}
#[no_mangle]
pub extern "C" fn _exit(code: i32) -> ! {
    panic!("_exit({code}) called");
}
#[no_mangle]
pub extern "C" fn _open(_p: *const u8, _f: i32, _m: i32) -> i32 {
    -1
}
#[no_mangle]
pub extern "C" fn _gettimeofday(tv: *mut u64, _tz: *mut c_void) -> i32 {
    unsafe {
        if !tv.is_null() {
            *tv = 0;
            *tv.add(1) = 0;
        }
    }
    0
}
#[no_mangle]
pub extern "C" fn _times(_b: *mut c_void) -> isize {
    0
}
#[no_mangle]
pub extern "C" fn _unlink(_p: *const u8) -> i32 {
    -1
}
#[no_mangle]
pub extern "C" fn _link(_a: *const u8, _b: *const u8) -> i32 {
    -1
}
#[no_mangle]
pub extern "C" fn _stat(_p: *const u8, _st: *mut u8) -> i32 {
    -1
}

// rv64im has no A extension, so GCC lowers 64-bit atomics to libatomic calls.
// The guest is single-threaded: plain loads and stores are exact.
#[no_mangle]
pub unsafe extern "C" fn __atomic_fetch_add_8(p: *mut u64, v: u64, _m: i32) -> u64 {
    let old = *p;
    *p = old.wrapping_add(v);
    old
}
#[no_mangle]
pub unsafe extern "C" fn __atomic_fetch_sub_8(p: *mut u64, v: u64, _m: i32) -> u64 {
    let old = *p;
    *p = old.wrapping_sub(v);
    old
}
#[no_mangle]
pub unsafe extern "C" fn __atomic_compare_exchange_8(
    p: *mut u64,
    expected: *mut u64,
    desired: u64,
    _s: i32,
    _f: i32,
) -> bool {
    if *p == *expected {
        *p = desired;
        true
    } else {
        *expected = *p;
        false
    }
}
