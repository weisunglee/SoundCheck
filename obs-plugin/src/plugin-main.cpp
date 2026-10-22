#include <obs-frontend-api.h>
#include <obs-module.h>

#include "obs-websocket-api.h"
#include "stream-tracks.hpp"
#include "tap.hpp"

OBS_DECLARE_MODULE()

extern "C" const char *obs_module_name(void) { return "obs-audio-kit"; }
extern "C" const char *obs_module_description(void)
{
    return "Companion for the obs-audio-kit app: lets it listen to the stream mix.";
}

static Tap g_tap;
static obs_websocket_vendor g_vendor = nullptr;

static void set_error(obs_data_t *response, const char *message)
{
    obs_data_set_bool(response, "ok", false);
    obs_data_set_string(response, "error", message);
}

// Vendor request "GetInfo": which tracks go to the stream, and the tap state.
static void handle_get_info(obs_data_t *, obs_data_t *response, void *)
{
    StreamTracks stream = get_stream_tracks();
    obs_data_array_t *tracks = obs_data_array_create();
    for (int t : stream.tracks) {
        obs_data_t *item = obs_data_create();
        obs_data_set_int(item, "track", t);
        obs_data_array_push_back(tracks, item);
        obs_data_release(item);
    }

    obs_data_set_bool(response, "ok", true);
    obs_data_set_string(response, "pluginVersion", PLUGIN_VERSION);
    obs_data_set_bool(response, "streaming", obs_frontend_streaming_active());
    obs_data_set_array(response, "streamTracks", tracks);
    obs_data_set_string(response, "streamTracksOrigin", stream.origin.c_str());
    obs_data_set_bool(response, "tapRunning", g_tap.running());
    obs_data_array_release(tracks);
}

// Vendor request "StartTap" { track?: 1-6 }: defaults to the first stream track.
static void handle_start_tap(obs_data_t *request, obs_data_t *response, void *)
{
    int track = int(obs_data_get_int(request, "track"));
    if (track == 0)
        track = get_stream_tracks().tracks.front();

    uint16_t port = g_tap.start(track);
    if (port == 0) {
        set_error(response, "could not start the tap");
        return;
    }

    obs_data_set_bool(response, "ok", true);
    obs_data_set_int(response, "track", track);
    obs_data_set_int(response, "port", port);
    obs_data_set_int(response, "sampleRate", Tap::kSampleRate);
    obs_data_set_int(response, "channels", Tap::kChannels);
    obs_data_set_string(response, "format", "f32le");
}

static void handle_stop_tap(obs_data_t *, obs_data_t *response, void *)
{
    g_tap.stop();
    obs_data_set_bool(response, "ok", true);
}

bool obs_module_load(void)
{
    if (!tap_sockets_init()) {
        blog(LOG_ERROR, "[obs-audio-kit] socket setup failed");
        return false;
    }
    blog(LOG_INFO, "[obs-audio-kit] module loaded (version %s)", PLUGIN_VERSION);
    return true;
}

// obs-websocket registers its vendor API during load, so vendors attach after all modules load.
void obs_module_post_load(void)
{
    g_vendor = obs_websocket_register_vendor("obs-audio-kit");
    if (!g_vendor) {
        blog(LOG_WARNING, "[obs-audio-kit] obs-websocket not available; app control disabled");
        return;
    }
    obs_websocket_vendor_register_request(g_vendor, "GetInfo", handle_get_info, nullptr);
    obs_websocket_vendor_register_request(g_vendor, "StartTap", handle_start_tap, nullptr);
    obs_websocket_vendor_register_request(g_vendor, "StopTap", handle_stop_tap, nullptr);
}

void obs_module_unload(void)
{
    g_tap.stop();
    tap_sockets_shutdown();
    blog(LOG_INFO, "[obs-audio-kit] module unloaded");
}
