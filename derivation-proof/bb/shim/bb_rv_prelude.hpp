// Forced include for the SP1 rv64im build of bb: fills gaps of a newlib,
// no-threads libstdc++ that bb's headers assume a hosted platform provides.
#pragma once
#define MSGPACK_ENDIAN_LITTLE_BYTE 1
#define MSGPACK_ENDIAN_BIG_BYTE 0
#include <sys/types.h>
#include "arpa/inet.h"
#define ntohll(x) __builtin_bswap64(x)
#define htonll(x) __builtin_bswap64(x)
#define be64toh(x) __builtin_bswap64(x)
#define htobe64(x) __builtin_bswap64(x)
#ifdef __cplusplus
extern "C" inline int ftruncate(int, off_t) { return -1; }
#include <cstdint>
#include <cstdlib>
#include <cstddef>
inline void aligned_free(void* mem) { std::free(mem); }
namespace std {
// Single-threaded guest: locks are no-ops.
struct mutex {
    constexpr mutex() noexcept = default;
    mutex(const mutex&) = delete;
    mutex& operator=(const mutex&) = delete;
    void lock() {}
    bool try_lock() { return true; }
    void unlock() {}
};
struct recursive_mutex : mutex {};
struct timed_mutex : mutex {};
struct shared_mutex : mutex {
    void lock_shared() {}
    bool try_lock_shared() { return true; }
    void unlock_shared() {}
};
} // namespace std
#endif
