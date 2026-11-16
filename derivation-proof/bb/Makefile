# bb's Chonk verifier and its bbapi commands, cross-compiled with SP1's rv64im
# GCC with C++ exceptions, as $(OUT)/libchonk.a. toolchain.sh runs it with:
#
#   BB    aztec-packages' barretenberg/cpp/src at the pinned commit
#   DEPS  the header libraries and libdeflate, at the commits bb's CMake pins
#   GEN   chonk_verifier_native.cpp, which prepare.py cuts from BB
#   OUT   the build directory
#   CXX, CC, AR  SP1's riscv64-unknown-elf tools

HERE := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

BB_SRCS := $(addprefix $(BB)/barretenberg/,$(shell cat $(HERE)sources.txt))
BBAPI_SRCS := $(BB)/barretenberg/bbapi/bbapi_chonk.cpp $(HERE)pcash_bb.cpp
SRCS := $(BB_SRCS) $(BBAPI_SRCS) $(GEN)/chonk_verifier_native.cpp $(HERE)global_crs.cpp
C_SRCS := $(wildcard $(DEPS)/libdeflate/lib/*.c)

# -mno-relax: with relaxation, each function's .gcc_except_table carries ULEB128
# relocations into its .text, and lld keeps every LSDA an FDE names, so
# --gc-sections would keep (and need) all of bb's prover code.
ARCHFLAGS := -march=rv64im -mabi=lp64 -mcmodel=medany -mno-relax -ffunction-sections -fdata-sections \
	-DDISABLE_ASM=1 -isystem $(HERE)shim -include $(HERE)shim/bb_rv_prelude.hpp
DEFS := -DNO_MULTITHREADING -DMSGPACK_NO_BOOST -DMSGPACK_USE_STD_VARIANT_ADAPTOR
INCS := -I$(BB) -I$(DEPS)/msgpack-c/include -I$(DEPS)/nlohmann_json/include -I$(DEPS)/libdeflate \
	-I$(DEPS)/httplib -I$(DEPS)/tracy/public
CXXFLAGS := -std=c++20 -O2 $(ARCHFLAGS) $(DEFS) $(INCS) -w
CFLAGS := -O2 $(ARCHFLAGS) -I$(DEPS)/libdeflate -w

OBJS := $(patsubst /%,$(OUT)/%.o,$(SRCS) $(C_SRCS))

$(OUT)/libchonk.a: $(OBJS)
	@rm -f $@
	@$(AR) rcsD $@ $^

$(OUT)/%.cpp.o: /%.cpp
	@mkdir -p $(dir $@)
	@$(CXX) $(CXXFLAGS) -c $< -o $@

$(OUT)/%.c.o: /%.c
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) -c $< -o $@

# The Chonk batch verifier service needs FIFOs, signals and threads.
$(patsubst /%,$(OUT)/%.o,$(BBAPI_SRCS)): CXXFLAGS += -include $(HERE)shim/bbapi_no_batch_service.hpp
