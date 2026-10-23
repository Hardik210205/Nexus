#include "nsp/frame.h"

#include <algorithm>
#include <limits>
#include <utility>

namespace nsp {
namespace {

constexpr std::array<std::uint8_t, 4> kMagic{{'N', 'S', 'P', 0}};
constexpr std::uint16_t kCriticalExtensionBit = 0x8000;
constexpr std::uint16_t kExtensionIdMask = 0x7FFF;

std::uint16_t read_u16(const std::uint8_t *data) {
  return static_cast<std::uint16_t>((static_cast<std::uint16_t>(data[0]) << 8) |
                                    static_cast<std::uint16_t>(data[1]));
}

std::uint32_t read_u32(const std::uint8_t *data) {
  return (static_cast<std::uint32_t>(data[0]) << 24) |
         (static_cast<std::uint32_t>(data[1]) << 16) |
         (static_cast<std::uint32_t>(data[2]) << 8) |
         static_cast<std::uint32_t>(data[3]);
}

void write_u16(std::vector<std::uint8_t> &output, std::size_t offset,
               std::uint16_t value) {
  output[offset] = static_cast<std::uint8_t>(value >> 8);
  output[offset + 1] = static_cast<std::uint8_t>(value);
}

void write_u32(std::vector<std::uint8_t> &output, std::size_t offset,
               std::uint32_t value) {
  output[offset] = static_cast<std::uint8_t>(value >> 24);
  output[offset + 1] = static_cast<std::uint8_t>(value >> 16);
  output[offset + 2] = static_cast<std::uint8_t>(value >> 8);
  output[offset + 3] = static_cast<std::uint8_t>(value);
}

void validate_version(std::uint8_t major, std::uint8_t minor) {
  if (major != kProtocolMajor || minor > kProtocolMinor) {
    throw FrameError(ErrorCode::unsupported_version, "unsupported NSP version");
  }
}

bool has_nonzero_message_id(const std::array<std::uint8_t, 16> &message_id) {
  return std::any_of(message_id.begin(), message_id.end(),
                     [](std::uint8_t byte) { return byte != 0; });
}

std::size_t header_length_for(const Frame &frame) {
  std::size_t length = kFixedHeaderLength;
  for (const auto &extension : frame.extensions) {
    if (extension.id == 0 || extension.id > kExtensionIdMask ||
        extension.value.size() > std::numeric_limits<std::uint16_t>::max()) {
      throw FrameError(ErrorCode::malformed_extension,
                       "invalid extension identifier or length");
    }
    if (length > kMaximumHeaderLength - 4 ||
        extension.value.size() > kMaximumHeaderLength - length - 4) {
      throw FrameError(ErrorCode::invalid_header_length,
                       "header exceeds maximum length");
    }
    length += 4 + extension.value.size();
  }
  return length;
}

void validate_payload_length(MessageType type, std::size_t payload_length);

std::size_t declared_frame_length(const std::vector<std::uint8_t> &buffer) {
  if (buffer.size() < kFixedHeaderLength) {
    return 0;
  }
  if (!std::equal(kMagic.begin(), kMagic.end(), buffer.begin())) {
    throw FrameError(ErrorCode::invalid_magic, "invalid NSP magic");
  }
  validate_version(buffer[4], buffer[5]);
  const auto raw_type = buffer[6];
  if (!is_known_message_type(raw_type)) {
    throw FrameError(ErrorCode::unknown_message_type, "unknown message type");
  }
  const auto type = static_cast<MessageType>(raw_type);
  validate_message_type_and_flags(type, buffer[7]);
  const std::size_t header_length = read_u16(buffer.data() + 8);
  if (header_length < kFixedHeaderLength ||
      header_length > kMaximumHeaderLength) {
    throw FrameError(ErrorCode::invalid_header_length,
                     "invalid NSP header length");
  }
  if (read_u16(buffer.data() + 10) != 0) {
    throw FrameError(ErrorCode::invalid_reserved_field,
                     "reserved header field must be zero");
  }
  const std::uint32_t payload_length = read_u32(buffer.data() + 12);
  validate_payload_length(type, payload_length);
  return header_length + static_cast<std::size_t>(payload_length);
}

void validate_extensions(const std::vector<Extension> &extensions) {
  for (std::size_t index = 0; index < extensions.size(); ++index) {
    const auto &extension = extensions[index];
    if (extension.id == 0 || extension.id > kExtensionIdMask) {
      throw FrameError(ErrorCode::malformed_extension,
                       "invalid extension identifier");
    }
    for (std::size_t prior = 0; prior < index; ++prior) {
      if (extensions[prior].id == extension.id) {
        throw FrameError(ErrorCode::duplicate_extension,
                         "duplicate extension identifier");
      }
    }
    if (extension.critical) {
      throw FrameError(ErrorCode::unsupported_critical_extension,
                       "unsupported critical extension");
    }
  }
}

void validate_payload_length(MessageType type, std::size_t payload_length) {
  if (payload_length > kMaximumPayloadLength) {
    throw FrameError(ErrorCode::payload_too_large,
                     "payload exceeds maximum length");
  }
  if (is_control_message(type) && payload_length > kControlPayloadLimit) {
    throw FrameError(ErrorCode::payload_too_large,
                     "control payload exceeds maximum length");
  }
}

} // namespace

std::vector<std::uint8_t> encode_frame(const Frame &frame) {
  validate_version(frame.major, frame.minor);
  validate_message_type_and_flags(frame.type, frame.flags);
  validate_payload_length(frame.type, frame.payload.size());
  validate_extensions(frame.extensions);

  if (!has_nonzero_message_id(frame.message_id)) {
    throw FrameError(ErrorCode::zero_message_id,
                     "message identifier must not be zero");
  }

  const std::size_t header_length = header_length_for(frame);
  const std::size_t frame_length = header_length + frame.payload.size();
  if (frame_length > kMaximumFrameLength) {
    throw FrameError(ErrorCode::payload_too_large,
                     "frame exceeds maximum length");
  }

  std::vector<std::uint8_t> output(frame_length, 0);
  std::copy(kMagic.begin(), kMagic.end(), output.begin());
  output[4] = frame.major;
  output[5] = frame.minor;
  output[6] = static_cast<std::uint8_t>(frame.type);
  output[7] = frame.flags;
  write_u16(output, 8, static_cast<std::uint16_t>(header_length));
  write_u16(output, 10, 0);
  write_u32(output, 12, static_cast<std::uint32_t>(frame.payload.size()));
  std::copy(frame.message_id.begin(), frame.message_id.end(),
            output.begin() + 16);

  std::size_t offset = kFixedHeaderLength;
  for (const auto &extension : frame.extensions) {
    const auto encoded_id = static_cast<std::uint16_t>(
        extension.id | (extension.critical ? kCriticalExtensionBit : 0));
    write_u16(output, offset, encoded_id);
    write_u16(output, offset + 2,
              static_cast<std::uint16_t>(extension.value.size()));
    std::copy(extension.value.begin(), extension.value.end(),
              output.begin() + static_cast<std::ptrdiff_t>(offset + 4));
    offset += 4 + extension.value.size();
  }

  std::copy(frame.payload.begin(), frame.payload.end(),
            output.begin() + static_cast<std::ptrdiff_t>(header_length));
  return output;
}

Frame decode_frame(const std::uint8_t *data, std::size_t size) {
  if (data == nullptr) {
    throw FrameError(ErrorCode::null_input, "frame input is null");
  }
  if (size < kFixedHeaderLength) {
    throw FrameError(ErrorCode::truncated_header,
                     "frame is shorter than fixed header");
  }
  if (!std::equal(kMagic.begin(), kMagic.end(), data)) {
    throw FrameError(ErrorCode::invalid_magic, "invalid NSP magic");
  }

  const auto major = data[4];
  const auto minor = data[5];
  validate_version(major, minor);

  const auto raw_type = data[6];
  if (!is_known_message_type(raw_type)) {
    throw FrameError(ErrorCode::unknown_message_type, "unknown message type");
  }
  const auto type = static_cast<MessageType>(raw_type);
  const auto flags = data[7];
  validate_message_type_and_flags(type, flags);

  const std::size_t header_length = read_u16(data + 8);
  if (header_length < kFixedHeaderLength ||
      header_length > kMaximumHeaderLength || header_length > size) {
    throw FrameError(ErrorCode::invalid_header_length,
                     "invalid NSP header length");
  }
  if (read_u16(data + 10) != 0) {
    throw FrameError(ErrorCode::invalid_reserved_field,
                     "reserved header field must be zero");
  }

  const std::uint32_t payload_length = read_u32(data + 12);
  validate_payload_length(type, payload_length);
  if (header_length > std::numeric_limits<std::size_t>::max() -
                          static_cast<std::size_t>(payload_length)) {
    throw FrameError(ErrorCode::frame_size_mismatch,
                     "frame length overflows addressable size");
  }
  const std::size_t expected_size =
      header_length + static_cast<std::size_t>(payload_length);
  if (size != expected_size) {
    throw FrameError(ErrorCode::frame_size_mismatch,
                     "input does not contain exactly one complete frame");
  }

  Frame frame;
  frame.major = major;
  frame.minor = minor;
  frame.type = type;
  frame.flags = flags;
  std::copy(data + 16, data + 32, frame.message_id.begin());
  if (!has_nonzero_message_id(frame.message_id)) {
    throw FrameError(ErrorCode::zero_message_id,
                     "message identifier must not be zero");
  }

  std::size_t offset = kFixedHeaderLength;
  while (offset < header_length) {
    if (header_length - offset < 4) {
      throw FrameError(ErrorCode::malformed_extension,
                       "truncated extension header");
    }
    const auto encoded_id = read_u16(data + offset);
    const auto id = static_cast<std::uint16_t>(encoded_id & kExtensionIdMask);
    const bool critical = (encoded_id & kCriticalExtensionBit) != 0;
    const std::size_t extension_length = read_u16(data + offset + 2);
    offset += 4;

    if (id == 0 || extension_length > header_length - offset) {
      throw FrameError(ErrorCode::malformed_extension,
                       "invalid extension identifier or length");
    }
    for (const auto &existing : frame.extensions) {
      if (existing.id == id) {
        throw FrameError(ErrorCode::duplicate_extension,
                         "duplicate extension identifier");
      }
    }
    if (critical) {
      throw FrameError(ErrorCode::unsupported_critical_extension,
                       "unsupported critical extension");
    }

    Extension extension{id, false, {}};
    extension.value.assign(data + offset,
                           data + offset +
                               static_cast<std::ptrdiff_t>(extension_length));
    frame.extensions.push_back(std::move(extension));
    offset += extension_length;
  }

  frame.payload.assign(data + header_length,
                       data + header_length +
                           static_cast<std::ptrdiff_t>(payload_length));
  return frame;
}

Frame decode_frame(const std::vector<std::uint8_t> &data) {
  return decode_frame(data.data(), data.size());
}

std::vector<Frame> FrameStreamDecoder::feed(const std::uint8_t *data,
                                            std::size_t size) {
  if (data == nullptr && size != 0) {
    throw FrameError(ErrorCode::null_input, "frame input is null");
  }

  std::vector<Frame> frames;
  std::size_t consumed = 0;
  while (consumed < size) {
    const std::size_t available =
        kMaximumBufferedBytesPerConnection - buffer_.size();
    if (available == 0) {
      throw FrameError(ErrorCode::buffer_limit_exceeded,
                       "connection buffer limit exceeded");
    }
    const std::size_t amount = std::min(available, size - consumed);
    buffer_.insert(buffer_.end(), data + consumed,
                   data + consumed + static_cast<std::ptrdiff_t>(amount));
    consumed += amount;

    std::size_t frame_length = declared_frame_length(buffer_);
    while (frame_length != 0 && buffer_.size() >= frame_length) {
      frames.push_back(decode_frame(buffer_.data(), frame_length));
      buffer_.erase(buffer_.begin(),
                    buffer_.begin() +
                        static_cast<std::ptrdiff_t>(frame_length));
      frame_length = declared_frame_length(buffer_);
    }
  }
  return frames;
}

std::vector<Frame>
FrameStreamDecoder::feed(const std::vector<std::uint8_t> &data) {
  return feed(data.data(), data.size());
}

} // namespace nsp
