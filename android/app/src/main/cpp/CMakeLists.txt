# whisper.cpp — telefonning o'zida (internetsiz) nutqni matnga aylantirish.
# Manba kodi yig'ish paytida GitHub'dan yuklab olinadi.
cmake_minimum_required(VERSION 3.22.1)
project(tilwhisper C CXX)

# Debug APK'da ham tez ishlashi uchun doimo optimallashtirilgan holda yig'amiz
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
set(CMAKE_CXX_STANDARD 17)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2 OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)

include(FetchContent)
FetchContent_Declare(
    whisper
    URL https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.4.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(whisper)

add_library(tilwhisper SHARED tilwhisper.cpp)
target_compile_options(tilwhisper PRIVATE -O3)
target_link_libraries(tilwhisper PRIVATE whisper log android)
