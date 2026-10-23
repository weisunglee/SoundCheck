// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

#pragma once

#include <cstddef>

#include "stream-tracks.hpp"

struct obs_data;
typedef struct obs_data obs_data_t;

/** What the program hosting the plugin (OBS or Streamlabs) knows about the stream. */
struct Host {
    StreamTracks (*stream_tracks)();
    bool (*streaming)();
};

/** The requests the app can send, by name. */
extern const char *const kRequestNames[];
extern const size_t kRequestCount;

/**
 * Answers one request from the app. Sets "ok" (and "error" when it fails) in `response`;
 * returns false for an unknown request type.
 */
bool handle_request(const Host &host, const char *type, obs_data_t *request, obs_data_t *response);

/** Puts the stream audio back and stops the tap; for unload and shutdown. */
void requests_shutdown();

/** Puts the stream audio back, e.g. before the host saves the scene collection. */
void requests_resume_stream_audio();
