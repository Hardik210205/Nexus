#include "nsp/errors.h"
#include "nsp/frame.h"
#include "nsp/message.h"

#include <array>
#include <cstdint>
#include <exception>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

template <typename Callback>
void expect_error(nsp::ErrorCode expected, Callback callback) {
  try {
    callback();
  } catch (const nsp::FrameError &error) {
    require(error.code() == expected,
            "unexpected NSP error code: expected " +
                std::to_string(static_cast<int>(expected)) + ", got " +
                std::to_string(static_cast<int>(error.code())));
    return;
  }
  throw std::runtime_error("expected NSP frame error code " +
                           std::to_string(static_cast<int>(expected)));
}

nsp::Frame sample_frame() {
  nsp::Frame frame;
  frame.type = nsp::MessageType::telemetry;
  frame.flags = nsp::kAckRequired;
  frame.message_id[0] = 0x01;
  frame.message_id[15] = 0xFF;
  frame.payload = {0xA1, 0x00, 0x01};
  return frame;
}

void test_known_encoding() {
  const auto encoded = nsp::encode_frame(sample_frame());
  const std::vector<std::uint8_t> expected{
      'N', 'S', 'P', 0, 1, 0, 0x10, 1, 0, 32, 0, 0, 0, 0,    0,    3,    1,   0,
      0,   0,   0,   0, 0, 0, 0,    0, 0, 0,  0, 0, 0, 0xFF, 0xA1, 0x00, 0x01};
  require(encoded == expected, "wire encoding does not match v1.0 bytes");
}

void test_round_trip_and_optional_extension() {
  auto frame = sample_frame();
  frame.type = nsp::MessageType::device_status;
  frame.flags = nsp::kAckRequired;
  frame.extensions.push_back({7, false, {0x10, 0x20}});

  const auto decoded = nsp::decode_frame(nsp::encode_frame(frame));
  require(decoded.major == frame.major, "major version did not round-trip");
  require(decoded.minor == frame.minor, "minor version did not round-trip");
  require(decoded.type == frame.type, "message type did not round-trip");
  require(decoded.flags == frame.flags, "flags did not round-trip");
  require(decoded.message_id == frame.message_id,
          "message ID did not round-trip");
  require(decoded.payload == frame.payload, "payload did not round-trip");
  require(decoded.extensions.size() == 1, "extension was not retained");
  require(decoded.extensions[0].id == 7, "extension ID changed");
  require(decoded.extensions[0].value ==
              std::vector<std::uint8_t>({0x10, 0x20}),
          "extension value changed");
}

void test_header_extension_boundary() {
  auto frame = sample_frame();
  frame.extensions.push_back({3, false, std::vector<std::uint8_t>(220, 0x5A)});
  const auto encoded = nsp::encode_frame(frame);
  require(encoded.size() == nsp::kMaximumHeaderLength + frame.payload.size(),
          "maximum-sized header has the wrong wire size");
  require(nsp::decode_frame(encoded).extensions[0].value.size() == 220,
          "maximum-sized header did not decode");

  frame.extensions[0].value.push_back(0x5A);
  expect_error(nsp::ErrorCode::invalid_header_length,
               [&] { (void)nsp::encode_frame(frame); });
}

void test_control_and_payload_limits() {
  auto control = sample_frame();
  control.type = nsp::MessageType::heartbeat;
  control.flags = 0;
  control.payload.assign(nsp::kControlPayloadLimit, 0x01);
  require(nsp::decode_frame(nsp::encode_frame(control)).payload.size() ==
              nsp::kControlPayloadLimit,
          "maximum control payload was rejected");

  control.payload.push_back(0x01);
  expect_error(nsp::ErrorCode::payload_too_large,
               [&] { (void)nsp::encode_frame(control); });

  auto telemetry = sample_frame();
  telemetry.payload.assign(nsp::kMaximumPayloadLength, 0x02);
  require(nsp::decode_frame(nsp::encode_frame(telemetry)).payload.size() ==
              nsp::kMaximumPayloadLength,
          "maximum telemetry payload was rejected");
  telemetry.payload.push_back(0x02);
  expect_error(nsp::ErrorCode::payload_too_large,
               [&] { (void)nsp::encode_frame(telemetry); });
}

void test_invalid_fixed_header() {
  const auto valid = nsp::encode_frame(sample_frame());
  expect_error(nsp::ErrorCode::truncated_header,
               [&] { (void)nsp::decode_frame(valid.data(), 31); });
  expect_error(nsp::ErrorCode::null_input,
               [&] { (void)nsp::decode_frame(nullptr, 32); });

  auto bytes = valid;
  bytes[0] = 'X';
  expect_error(nsp::ErrorCode::invalid_magic,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = valid;
  bytes[4] = 2;
  expect_error(nsp::ErrorCode::unsupported_version,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = valid;
  bytes[5] = 1;
  expect_error(nsp::ErrorCode::unsupported_version,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = valid;
  bytes[6] = 0x7E;
  expect_error(nsp::ErrorCode::unknown_message_type,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = valid;
  bytes[7] = 0x80;
  expect_error(nsp::ErrorCode::invalid_flags,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = valid;
  bytes[6] = static_cast<std::uint8_t>(nsp::MessageType::heartbeat);
  bytes[7] = nsp::kAckRequired;
  expect_error(nsp::ErrorCode::invalid_flags,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = valid;
  bytes[10] = 0;
  bytes[11] = 1;
  expect_error(nsp::ErrorCode::invalid_reserved_field,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = valid;
  bytes[8] = 0;
  bytes[9] = 31;
  expect_error(nsp::ErrorCode::invalid_header_length,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = valid;
  bytes[8] = 1;
  bytes[9] = 1;
  expect_error(nsp::ErrorCode::invalid_header_length,
               [&] { (void)nsp::decode_frame(bytes); });
}

void test_invalid_lengths_and_ids() {
  const auto valid = nsp::encode_frame(sample_frame());
  expect_error(nsp::ErrorCode::frame_size_mismatch, [&] {
    (void)nsp::decode_frame(valid.data(), valid.size() - 1);
  });

  auto trailing = valid;
  trailing.push_back(0);
  expect_error(nsp::ErrorCode::frame_size_mismatch,
               [&] { (void)nsp::decode_frame(trailing); });

  auto too_large = valid;
  too_large[12] = 0;
  too_large[13] = 1;
  too_large[14] = 0;
  too_large[15] = 1;
  expect_error(nsp::ErrorCode::payload_too_large,
               [&] { (void)nsp::decode_frame(too_large); });

  auto zero_id = sample_frame();
  zero_id.message_id.fill(0);
  expect_error(nsp::ErrorCode::zero_message_id,
               [&] { (void)nsp::encode_frame(zero_id); });
  expect_error(nsp::ErrorCode::zero_message_id, [&] {
    auto bytes = valid;
    for (std::size_t i = 16; i < 32; ++i)
      bytes[i] = 0;
    (void)nsp::decode_frame(bytes);
  });
}

void test_extension_validation() {
  auto frame = sample_frame();
  frame.extensions = {{2, false, {1}}, {2, false, {2}}};
  expect_error(nsp::ErrorCode::duplicate_extension,
               [&] { (void)nsp::encode_frame(frame); });

  frame.extensions = {{0, false, {1}}};
  expect_error(nsp::ErrorCode::malformed_extension,
               [&] { (void)nsp::encode_frame(frame); });

  frame.extensions = {{1, true, {1}}};
  expect_error(nsp::ErrorCode::unsupported_critical_extension,
               [&] { (void)nsp::encode_frame(frame); });

  auto bytes = nsp::encode_frame(sample_frame());
  bytes[8] = 0;
  bytes[9] = 35;
  bytes.insert(bytes.begin() + 32, {0, 1, 0});
  expect_error(nsp::ErrorCode::malformed_extension,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = nsp::encode_frame(sample_frame());
  bytes[8] = 0;
  bytes[9] = 36;
  bytes.insert(bytes.begin() + 32, {0x80, 1, 0, 0});
  expect_error(nsp::ErrorCode::unsupported_critical_extension,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = nsp::encode_frame(sample_frame());
  bytes[8] = 0;
  bytes[9] = 36;
  bytes.insert(bytes.begin() + 32, {0, 0, 0, 0});
  expect_error(nsp::ErrorCode::malformed_extension,
               [&] { (void)nsp::decode_frame(bytes); });

  bytes = nsp::encode_frame(sample_frame());
  bytes[8] = 0;
  bytes[9] = 40;
  bytes.insert(bytes.begin() + 32, {0, 1, 0, 0, 0, 1, 0, 0});
  expect_error(nsp::ErrorCode::duplicate_extension,
               [&] { (void)nsp::decode_frame(bytes); });
}

void test_header_size_and_type_flags() {
  auto frame = sample_frame();
  frame.extensions.push_back(
      {1, false, std::vector<std::uint8_t>(nsp::kMaximumHeaderLength, 0)});
  expect_error(nsp::ErrorCode::invalid_header_length,
               [&] { (void)nsp::encode_frame(frame); });

  frame = sample_frame();
  frame.type = nsp::MessageType::configuration_update;
  frame.flags = nsp::kAckRequired;
  expect_error(nsp::ErrorCode::invalid_flags,
               [&] { (void)nsp::encode_frame(frame); });

  require(nsp::is_control_message(nsp::MessageType::hello),
          "HELLO should be classified as control");
  require(!nsp::is_control_message(nsp::MessageType::telemetry),
          "TELEMETRY should not be classified as control");
  require(!nsp::is_known_message_type(0xFE),
          "unregistered type reported as known");
  require(nsp::is_known_message_type(
              std::numeric_limits<std::uint8_t>::max()) == false,
          "out-of-range message type reported as known");
}

void test_stream_decoder() {
  const auto first = nsp::encode_frame(sample_frame());
  auto second_frame = sample_frame();
  second_frame.type = nsp::MessageType::device_status;
  second_frame.flags = 0;
  second_frame.message_id[0] = 0x02;
  const auto second = nsp::encode_frame(second_frame);

  nsp::FrameStreamDecoder decoder;
  const auto prefix = decoder.feed(first.data(), 13);
  require(prefix.empty(), "partial frame was emitted");
  require(decoder.buffered_bytes() == 13, "partial frame buffer size is wrong");

  std::vector<std::uint8_t> remainder(first.begin() + 13, first.end());
  remainder.insert(remainder.end(), second.begin(), second.end());
  const auto decoded = decoder.feed(remainder);
  require(decoded.size() == 2, "coalesced frames were not both emitted");
  require(decoded[0].message_id == sample_frame().message_id,
          "first streamed frame changed");
  require(decoded[1].message_id == second_frame.message_id,
          "second streamed frame changed");
  require(decoder.buffered_bytes() == 0, "completed frames remain buffered");
}

void test_stream_buffer_is_bounded() {
  nsp::FrameStreamDecoder decoder;
  std::vector<std::uint8_t> invalid(nsp::kMaximumBufferedBytesPerConnection + 1,
                                    0);
  expect_error(nsp::ErrorCode::invalid_magic,
               [&] { (void)decoder.feed(invalid); });
  require(decoder.buffered_bytes() <= nsp::kMaximumBufferedBytesPerConnection,
          "stream decoder exceeded its buffer limit");
}

} // namespace

int main() {
  try {
    test_known_encoding();
    test_round_trip_and_optional_extension();
    test_header_extension_boundary();
    test_control_and_payload_limits();
    test_invalid_fixed_header();
    test_invalid_lengths_and_ids();
    test_extension_validation();
    test_header_size_and_type_flags();
    test_stream_decoder();
    test_stream_buffer_is_bounded();
    std::cout << "All NSP core tests passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "NSP core test failure: " << error.what() << '\n';
    return 1;
  }
}
