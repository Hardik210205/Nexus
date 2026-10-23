#pragma once

#include "nsp/errors.h"
#include "nsp/message.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace nsp {

constexpr std::uint8_t kProtocolMajor = 1;
constexpr std::uint8_t kProtocolMinor = 0;
constexpr std::size_t kFixedHeaderLength = 32;
constexpr std::size_t kMaximumHeaderLength = 256;
constexpr std::size_t kMaximumFrameLength =
    kMaximumHeaderLength + kMaximumPayloadLength;
constexpr std::size_t kMaximumBufferedBytesPerConnection =
    kMaximumFrameLength * 2;

struct Extension {
  std::uint16_t id;
  bool critical;
  std::vector<std::uint8_t> value;
};

struct Frame {
  std::uint8_t major = kProtocolMajor;
  std::uint8_t minor = kProtocolMinor;
  MessageType type = MessageType::telemetry;
  std::uint8_t flags = 0;
  std::array<std::uint8_t, 16> message_id{};
  std::vector<Extension> extensions;
  std::vector<std::uint8_t> payload;
};

std::vector<std::uint8_t> encode_frame(const Frame &frame);
Frame decode_frame(const std::uint8_t *data, std::size_t size);
Frame decode_frame(const std::vector<std::uint8_t> &data);

class FrameStreamDecoder final {
public:
  std::vector<Frame> feed(const std::uint8_t *data, std::size_t size);
  std::vector<Frame> feed(const std::vector<std::uint8_t> &data);
  std::size_t buffered_bytes() const noexcept { return buffer_.size(); }

private:
  std::vector<std::uint8_t> buffer_;
};

} // namespace nsp
