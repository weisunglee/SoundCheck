cmake_minimum_required(VERSION 3.28...3.30)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/common/bootstrap.cmake" NO_POLICY_SCOPE)

project(${_name} VERSION ${_version} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(compilerconfig)
include(defaults)
include(helpers)

# ON builds the Streamlabs Desktop variant (soundcheck-streamlabs): no obs-websocket or frontend
# API, and a control port of its own instead (see src/plugin-streamlabs.cpp).
option(SOUNDCHECK_STREAMLABS "Build for Streamlabs Desktop" OFF)

find_package(libobs REQUIRED)

add_library(${CMAKE_PROJECT_NAME} MODULE
  src/requests.cpp
  src/source-meters.cpp
  src/stream-pause.cpp
  src/tap.cpp
)
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE
  OBS::libobs
  $<$<PLATFORM_ID:Windows>:ws2_32>
)
target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE PLUGIN_VERSION="${PLUGIN_VERSION}")

if(SOUNDCHECK_STREAMLABS)
  target_sources(${CMAKE_PROJECT_NAME} PRIVATE src/plugin-streamlabs.cpp src/stream-outputs.cpp)
  set_target_properties_plugin(${CMAKE_PROJECT_NAME} PROPERTIES OUTPUT_NAME ${_name}-streamlabs)
else()
  find_package(obs-frontend-api REQUIRED)
  target_sources(${CMAKE_PROJECT_NAME} PRIVATE src/plugin-obs.cpp src/stream-tracks.cpp)
  target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE OBS::obs-frontend-api)
  set_target_properties_plugin(${CMAKE_PROJECT_NAME} PROPERTIES OUTPUT_NAME ${_name})
endif()
