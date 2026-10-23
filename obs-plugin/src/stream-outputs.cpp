#include "stream-tracks.hpp"

#include <obs-module.h>

static constexpr int kMaxTracks = 6;

/** The first active output that has a streaming service, with a reference, or null. */
static obs_output_t *active_stream_output()
{
    obs_output_t *found = nullptr;
    obs_enum_outputs(
        [](void *param, obs_output_t *output) {
            if (obs_output_active(output) && obs_output_get_service(output)) {
                *static_cast<obs_output_t **>(param) = obs_output_get_ref(output);
                return false;
            }
            return true;
        },
        &found);
    return found;
}

StreamTracks get_stream_tracks_from_outputs()
{
    StreamTracks result;
    if (obs_output_t *output = active_stream_output()) {
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
    // Streamlabs streams track 1 unless its advanced output settings pick another.
    result.tracks = {1};
    result.origin = "default";
    return result;
}

bool stream_output_active()
{
    obs_output_t *output = active_stream_output();
    obs_output_release(output);
    return output != nullptr;
}
