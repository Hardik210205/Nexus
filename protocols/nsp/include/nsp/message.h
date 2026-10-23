#pragma once

#include <cstdint>

namespace nsp {

enum class MessageType : std::uint8_t {
  hello = 0x01,
  authentication_result = 0x02,
  capability_negotiation = 0x03,
  telemetry = 0x10,
  acknowledgement = 0x11,
  error = 0x12,
  heartbeat = 0x13,
  goodbye = 0x14,
  device_status = 0x15,
  configuration_update = 0x16,
  protocol_extension = 0x7F,
};

constexpr std::uint8_t kAckRequired = 0x01;
constexpr std::uint8_t kKnownFlags = kAckRequired;
constexpr std::uint32_t kControlPayloadLimit = 4096;
constexpr std::uint32_t kMaximumPayloadLength = 65536;

bool is_known_message_type(std::uint8_t value) noexcept;
void validate_message_type_and_flags(MessageType type, std::uint8_t flags);
bool is_control_message(MessageType type) noexcept;

} // namespace nsp
