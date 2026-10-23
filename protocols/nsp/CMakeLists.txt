cmake_minimum_required(VERSION 3.20)

project(nexus_nsp VERSION 1.0.0 LANGUAGES CXX)

option(NSP_BUILD_TESTS "Build the NSP unit tests" ON)
option(NSP_ENABLE_SANITIZERS "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(NSP_BUILD_FUZZER "Build the libFuzzer frame decoder target (Clang only)" OFF)

add_library(nsp_core
    src/frame.cpp
    src/message.cpp
)

add_library(nsp::core ALIAS nsp_core)
target_include_directories(nsp_core PUBLIC include)
target_compile_features(nsp_core PUBLIC cxx_std_17)
set_target_properties(nsp_core PROPERTIES CXX_EXTENSIONS OFF)

if(MSVC)
    target_compile_options(nsp_core PRIVATE /W4 /WX /permissive-)
else()
    target_compile_options(nsp_core PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

if(NSP_ENABLE_SANITIZERS)
    if(MSVC)
        message(FATAL_ERROR "NSP_ENABLE_SANITIZERS requires a compiler with ASan and UBSan support")
    endif()
    target_compile_options(nsp_core PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(nsp_core PUBLIC -fsanitize=address,undefined)
endif()

if(NSP_BUILD_TESTS)
    enable_testing()
    add_executable(nsp_core_tests tests/test_nsp.cpp)
    target_link_libraries(nsp_core_tests PRIVATE nsp::core)
    if(MSVC)
        target_compile_options(nsp_core_tests PRIVATE /W4 /WX /permissive-)
    else()
        target_compile_options(nsp_core_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
    add_test(NAME nsp_core_tests COMMAND nsp_core_tests)
endif()

if(NSP_BUILD_FUZZER)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        message(FATAL_ERROR "NSP_BUILD_FUZZER requires Clang with libFuzzer support")
    endif()
    if(WIN32)
        message(FATAL_ERROR "The libFuzzer target is not supported by this Windows toolchain; use a supported Linux Clang toolchain")
    endif()
    target_compile_options(nsp_core PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    add_executable(nsp_frame_fuzzer fuzz/frame_fuzzer.cpp)
    target_link_libraries(nsp_frame_fuzzer PRIVATE nsp::core)
    target_compile_options(nsp_frame_fuzzer PRIVATE -fsanitize=fuzzer,address,undefined)
    target_link_options(nsp_frame_fuzzer PRIVATE -fsanitize=fuzzer,address,undefined)
endif()
