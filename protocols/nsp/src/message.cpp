#include "nsp/message.h"

#include "nsp/errors.h"

namespace nsp {

bool is_known_message_type(std::uint8_t value) noexcept {
  switch (static_cast<MessageType>(value)) {
  case MessageType::hello:
  case MessageType::authentication_result:
  case MessageType::capability_negotiation:
  case MessageType::telemetry:
  case MessageType::acknowledgement:
  case MessageType::error:
  case MessageType::heartbeat:
  case MessageType::goodbye:
  case MessageType::device_status:
  case MessageType::configuration_update:
  case MessageType::protocol_extension:
    return true;
  }
  return false;
}

bool is_control_message(MessageType type) noexcept {
  switch (type) {
  case MessageType::hello:
  case MessageType::authentication_result:
  case MessageType::capability_negotiation:
  case MessageType::acknowledgement:
  case MessageType::error:
  case MessageType::heartbeat:
  case MessageType::goodbye:
    return true;
  case MessageType::telemetry:
  case MessageType::device_status:
  case MessageType::configuration_update:
  case MessageType::protocol_extension:
    return false;
  }
  return false;
}

void validate_message_type_and_flags(MessageType type, std::uint8_t flags) {
  if (!is_known_message_type(static_cast<std::uint8_t>(type))) {
    throw FrameError(ErrorCode::unknown_message_type, "unknown message type");
  }
  if ((flags & static_cast<std::uint8_t>(~kKnownFlags)) != 0) {
    throw FrameError(ErrorCode::invalid_flags, "reserved flags must be zero");
  }
  if ((flags & kAckRequired) != 0 && type != MessageType::telemetry &&
      type != MessageType::device_status) {
    throw FrameError(
        ErrorCode::invalid_flags,
        "ACK_REQUIRED is only valid for telemetry and device status");
  }
}

} // namespace nsp
