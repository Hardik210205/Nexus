#pragma once

#include <stdexcept>

namespace nsp {

enum class ErrorCode {
  null_input,
  truncated_header,
  invalid_magic,
  unsupported_version,
  unknown_message_type,
  invalid_flags,
  invalid_header_length,
  invalid_reserved_field,
  payload_too_large,
  frame_size_mismatch,
  zero_message_id,
  malformed_extension,
  duplicate_extension,
  unsupported_critical_extension,
  buffer_limit_exceeded,
};

class FrameError final : public std::runtime_error {
public:
  FrameError(ErrorCode code, const char *message)
      : std::runtime_error(message), code_(code) {}

  ErrorCode code() const noexcept { return code_; }

private:
  ErrorCode code_;
};

} // namespace nsp
