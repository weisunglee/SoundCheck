#pragma once

#include <string>
#include <vector>

struct StreamTracks {
    /** 1-based track numbers the stream output encodes. */
    std::vector<int> tracks;
    /** Where the answer came from: "output", "config-advanced", "config-simple" or "default". */
    std::string origin;
};

/**
 * Asks OBS which audio tracks go to the stream. Prefers the live streaming
 * output's mixer mask and falls back to the profile's output settings.
 */
StreamTracks get_stream_tracks();

/**
 * Without OBS's frontend (Streamlabs): the mixer mask of the live output that sends to a
 * streaming service, or track 1 when nothing is streaming. See stream-outputs.cpp.
 */
StreamTracks get_stream_tracks_from_outputs();

/** Whether any output that sends to a streaming service is live. */
bool stream_output_active();
