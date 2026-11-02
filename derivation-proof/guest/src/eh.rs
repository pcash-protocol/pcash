//! Register the program's `.eh_frame` with libgcc's unwinder, so C++ exceptions
//! thrown inside bb can be caught.
//!
//! The riscv64-unknown-elf libgcc finds FDEs only in frames registered through
//! `__register_frame_info` (it has no `dl_iterate_phdr` path), and SP1 links with
//! rust-lld and without `crtbegin.o`, whose `frame_dummy` would register them. The
//! link passes `--eh-frame-hdr`; the `PT_GNU_EH_FRAME` program header locates
//! `.eh_frame_hdr`, whose `eh_frame_ptr` locates `.eh_frame`. lld ends `.eh_frame`
//! with the zero terminator at which the unwinder stops reading it.

extern "C" {
    static __ehdr_start: u8;
    fn __register_frame(begin: *const u8);
}

const PT_GNU_EH_FRAME: u32 = 0x6474_e550;
const DW_EH_PE_PCREL_SDATA4: u8 = 0x1b;

/// Once, before any C++ code can throw.
pub unsafe fn register_frames() {
    let ehdr = core::ptr::addr_of!(__ehdr_start);
    let phoff = *(ehdr.add(0x20) as *const u64) as usize;
    let phentsize = *(ehdr.add(0x36) as *const u16) as usize;
    let phnum = *(ehdr.add(0x38) as *const u16) as usize;
    for i in 0..phnum {
        let ph = ehdr.add(phoff + i * phentsize);
        if *(ph as *const u32) != PT_GNU_EH_FRAME {
            continue;
        }
        let hdr = *(ph.add(0x10) as *const u64) as *const u8;
        assert!(*hdr == 1 && *hdr.add(1) == DW_EH_PE_PCREL_SDATA4, "unexpected .eh_frame_hdr encoding");
        let eh_frame = hdr.add(4).offset(*(hdr.add(4) as *const i32) as isize);
        __register_frame(eh_frame);
        return;
    }
    panic!("no PT_GNU_EH_FRAME program header");
}
