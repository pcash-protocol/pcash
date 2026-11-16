#pragma once
#include <stddef.h>
#include <sys/types.h>
#include <stdlib.h>
// The verifier must not draw OS randomness; abort if anything asks.
static inline ssize_t getrandom(void* b, size_t n, unsigned f) { (void)b; (void)n; (void)f; abort(); }
static inline int getentropy(void* b, size_t n) { (void)b; (void)n; abort(); }
