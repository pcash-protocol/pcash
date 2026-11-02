#pragma once
#include <stddef.h>
#include <sys/types.h>
#define PROT_NONE 0
#define PROT_READ 1
#define PROT_WRITE 2
#define MAP_SHARED 1
#define MAP_PRIVATE 2
#define MAP_ANONYMOUS 0x20
#define MAP_ANON MAP_ANONYMOUS
#define MAP_FAILED ((void*)-1)
#define MADV_DONTNEED 4
static inline void* mmap(void* a, size_t l, int p, int f, int fd, off_t o) { (void)a; (void)l; (void)p; (void)f; (void)fd; (void)o; return MAP_FAILED; }
static inline int munmap(void* a, size_t l) { (void)a; (void)l; return -1; }
static inline int madvise(void* a, size_t l, int x) { (void)a; (void)l; (void)x; return 0; }
