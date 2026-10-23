# NSP C++ core

This standalone CMake project implements the NSP/1.0 fixed frame codec and
bounded TCP byte-stream assembly. It uses C++17 and only the standard library;
it has no TLS, socket, CBOR, database, or application dependencies.

## Build and test

With CMake 3.20+ and a C++17 compiler configured in the environment:

```powershell
cmake -S protocols/nsp -B build/nsp -DCMAKE_BUILD_TYPE=Debug
cmake --build build/nsp --config Debug
ctest --test-dir build/nsp -C Debug --output-on-failure
```

For the Windows Clang/MinGW toolchain used to verify the current build, set
`$toolRoot` to the extracted LLVM-MinGW directory and run:

```powershell
cmake -S protocols/nsp -B build/nsp-clang -G "MinGW Makefiles" `
  "-DCMAKE_CXX_COMPILER=$toolRoot\bin\clang++.exe" `
  "-DCMAKE_MAKE_PROGRAM=$toolRoot\bin\mingw32-make.exe" `
  -DCMAKE_BUILD_TYPE=Debug
cmake --build build/nsp-clang --config Debug
$env:PATH = "$toolRoot\bin;$env:PATH"
ctest --test-dir build/nsp-clang -C Debug --output-on-failure
```

Address and undefined behavior sanitizers can be enabled on supported
toolchains:

```powershell
cmake -S protocols/nsp -B build/nsp-sanitize `
  -DNSP_ENABLE_SANITIZERS=ON
cmake --build build/nsp-sanitize
$env:PATH = "$toolRoot\bin;$env:PATH"
ctest --test-dir build/nsp-sanitize --output-on-failure
```

The optional libFuzzer target is for supported Clang platforms. The Windows
MinGW Clang package used for the tested build does not support
`-fsanitize=fuzzer`; use an appropriate Linux Clang toolchain instead:

```sh
cmake -S protocols/nsp -B build/nsp-fuzz \
  -DNSP_BUILD_FUZZER=ON -DNSP_BUILD_TESTS=OFF
cmake --build build/nsp-fuzz --target nsp_frame_fuzzer
build/nsp-fuzz/nsp_frame_fuzzer -runs=10000
```

Creating a target is not evidence that a fuzz run has occurred. No fuzz run is
currently claimed.

## API and scope

- `nsp::encode_frame(const Frame&)` encodes an explicit big-endian wire
  representation; it never serializes a native C++ struct.
- `nsp::decode_frame(...)` parses exactly one bounded complete frame and
  returns a structured `Frame` or throws `nsp::FrameError` with an `ErrorCode`.
- `nsp::FrameStreamDecoder::feed(...)` accepts partial/coalesced TCP bytes,
  assembles full frames, and enforces the per-connection pending-byte cap.
- `nsp::MessageType` and `validate_message_type_and_flags(...)` define the
  registered type/flag checks implemented by this codec.

The codec accepts the v1.0 frame header and preserves unknown optional header
extensions; unknown critical extensions are rejected. It treats payload bytes
as opaque. It does not parse deterministic CBOR, run the HELLO/session state
machine, authenticate peers, authorize message operations, detect event
replays, persist telemetry, or send ACKs. Those features belong to later
milestones and are specified in [`protocol-specification.md`](../../docs/nsp/protocol-specification.md).
