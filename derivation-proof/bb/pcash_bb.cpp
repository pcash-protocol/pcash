// The PCASH node's two bb requests, run in process through bb's own bbapi
// command implementations (bbapi/bbapi_chonk.cpp):
//   1. ChonkDecompressProof on public_inputs ‖ proof.
//   2. ChonkVerify on (decompressed proof, vk).
// Between them the decompressed proof makes the msgpack round trip it makes
// between bb and the node: bb packs it into the first response, and unpacks it
// from the second request (barretenberg-rs carries each field's bytes as is).
//
// `bb msgpack run` answers any std::exception that escapes a request with an
// ErrorResponse carrying what() (bbapi/c_bind.cpp `bbapi`, api/api_msgpack.cpp);
// the try blocks below do the same. Anything else that escapes reaches
// std::terminate, as it does in bb, and the guest aborts.
//
// bb logs through `logstr` to std::cerr, and `msgpack run` points std::cout at
// std::cerr's buffer. While a request runs, both (and std::clog) write to a
// string instead, so the captured text is what the node's worker would have
// read from bb's stderr for that request.
#include "barretenberg/bbapi/bbapi_chonk.hpp"
#include "barretenberg/serialize/msgpack_impl.hpp"
#include "barretenberg/srs/global_crs.hpp"
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace bb;

namespace {

class StderrCapture {
  public:
    StderrCapture()
        : cerr_(std::cerr.rdbuf(&buffer_))
        , cout_(std::cout.rdbuf(&buffer_))
        , clog_(std::clog.rdbuf(&buffer_))
    {}
    ~StderrCapture()
    {
        std::cerr.rdbuf(cerr_);
        std::cout.rdbuf(cout_);
        std::clog.rdbuf(clog_);
    }
    StderrCapture(const StderrCapture&) = delete;
    StderrCapture& operator=(const StderrCapture&) = delete;
    std::string text() const { return buffer_.str(); }

  private:
    std::stringbuf buffer_;
    std::streambuf* cerr_;
    std::streambuf* cout_;
    std::streambuf* clog_;
};

char* heap_copy(const std::string& s)
{
    char* p = static_cast<char*>(std::malloc(s.size() + 1));
    std::memcpy(p, s.data(), s.size());
    p[s.size()] = 0;
    return p;
}

} // namespace

extern "C" {

// The reference strings the verifier reads, in bb's in-memory point layout:
// the Grumpkin points and BN254's first G1 point and [x]_2.
void pcash_crs_init(const uint8_t* grumpkin, size_t n_grumpkin, const uint8_t* g1, size_t n_g1, const uint8_t* g2)
{
    using GA = curve::Grumpkin::AffineElement;
    std::vector<GA> grumpkin_points(n_grumpkin);
    std::memcpy(static_cast<void*>(grumpkin_points.data()), grumpkin, n_grumpkin * sizeof(GA));
    std::vector<g1::affine_element> g1_points(n_g1);
    std::memcpy(static_cast<void*>(g1_points.data()), g1, n_g1 * sizeof(g1::affine_element));
    g2::affine_element g2_point;
    std::memcpy(static_cast<void*>(&g2_point), g2, sizeof(g2_point));
    srs::init_grumpkin_mem_crs_factory(grumpkin_points);
    srs::init_bn254_mem_crs_factory(g1_points, g2_point);
}

// Which request answered, as the node sees it.
enum : int32_t {
    // ChonkDecompressProof answered an ErrorResponse; `report` is its message.
    PCASH_BB_DECOMPRESSION_ERROR = 0,
    // ChonkVerify answered a ChonkVerifyResponse; `valid` is its flag and
    // `report` is everything bb logged while answering it.
    PCASH_BB_VERIFY_RESPONSE = 1,
    // ChonkVerify answered an ErrorResponse; `report` is its message.
    PCASH_BB_VERIFY_ERROR = 2,
};

struct pcash_bb_answer {
    int32_t request;
    int32_t valid;
    // malloc'd, NUL-terminated; the caller frees it.
    char* report;
    size_t report_len;
};

void pcash_bb_chonk(const uint8_t* vk,
                    size_t vk_len,
                    const uint8_t* public_inputs_and_proof,
                    size_t len,
                    pcash_bb_answer* answer)
{
    auto finish = [&](int32_t request, bool valid, const std::string& report) {
        answer->request = request;
        answer->valid = valid ? 1 : 0;
        answer->report = heap_copy(report);
        answer->report_len = report.size();
    };

    msgpack::sbuffer packed_proof;
    try {
        StderrCapture discarded; // the node reads only the error message here
        auto response =
            bbapi::ChonkDecompressProof{ .compressed_proof = std::vector<uint8_t>(public_inputs_and_proof,
                                                                                  public_inputs_and_proof + len) }
                .execute();
        msgpack::pack(packed_proof, response.proof);
    } catch (const std::exception& e) {
        finish(PCASH_BB_DECOMPRESSION_ERROR, false, e.what());
        return;
    }

    bool valid = false;
    std::string report;
    try {
        StderrCapture capture;
        bbapi::ChonkVerify request{ .proof = {}, .vk = std::vector<uint8_t>(vk, vk + vk_len) };
        msgpack::unpack(packed_proof.data(), packed_proof.size()).get().convert(request.proof);
        valid = std::move(request).execute().valid;
        report = capture.text();
    } catch (const std::exception& e) {
        finish(PCASH_BB_VERIFY_ERROR, false, e.what());
        return;
    }
    finish(PCASH_BB_VERIFY_RESPONSE, valid, report);
}

} // extern "C"
