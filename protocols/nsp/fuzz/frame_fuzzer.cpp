#include "nsp/frame.h"

#include <cstddef>
#include <cstdint>

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t *data,
                                      std::size_t size) {
  try {
    (void)nsp::decode_frame(data, size);
  } catch (const nsp::FrameError &) {
  }
  return 0;
}
