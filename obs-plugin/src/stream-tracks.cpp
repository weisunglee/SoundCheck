#include "stream-tracks.hpp"

#include <cstring>
#include <obs-frontend-api.h>
#include <obs-module.h>
#include <util/config-file.h>

static constexpr int kMaxTracks = 6;

StreamTracks get_stream_tracks()
{
    StreamTracks result;

    if (obs_output_t *output = obs_frontend_get_streaming_output()) {
        size_t mixers = obs_output_get_mixers(output);
        obs_output_release(output);
        for (int i = 0; i < kMaxTracks; i++) {
            if (mixers & (size_t(1) << i))
                result.tracks.push_back(i + 1);
        }
        if (!result.tracks.empty()) {
            result.origin = "output";
            return result;
        }
    }

    if (config_t *config = obs_frontend_get_profile_config()) {
        const char *mode = config_get_string(config, "Output", "Mode");
        if (mode && std::strcmp(mode, "Advanced") == 0) {
            int index = int(config_get_int(config, "AdvOut", "TrackIndex"));
            if (index >= 1 && index <= kMaxTracks) {
                result.tracks = {index};
                result.origin = "config-advanced";
                return result;
            }
        } else {
            // Simple output mode always streams track 1.
            result.tracks = {1};
            result.origin = "config-simple";
            return result;
        }
    }

    result.tracks = {1};
    result.origin = "default";
    return result;
}
