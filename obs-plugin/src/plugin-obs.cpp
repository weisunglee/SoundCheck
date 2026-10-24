// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

// The plugin as loaded by OBS Studio: the app reaches it through obs-websocket vendor requests,
// and OBS's frontend API says which tracks go to the stream.
#include <obs-frontend-api.h>
#include <obs-module.h>

#include "obs-websocket-api.h"
#include "requests.hpp"
#include "tap.hpp"
#include "voice-filters.hpp"

OBS_DECLARE_MODULE()

extern "C" const char *obs_module_name(void) { return "SoundCheck"; }
extern "C" const char *obs_module_description(void)
{
    return "Companion for the SoundCheck app: lets it listen to the stream mix and tune a voice.";
}

static const Host kHost = {get_stream_tracks, [] { return obs_frontend_streaming_active(); }};
static obs_websocket_vendor g_vendor = nullptr;

static void on_vendor_request(obs_data_t *request, obs_data_t *response, void *type)
{
    handle_request(kHost, static_cast<const char *>(type), request, response);
}

// Put the tracks back before OBS saves the scene collection on exit.
static void on_frontend_event(enum obs_frontend_event event, void *)
{
    if (event == OBS_FRONTEND_EVENT_EXIT || event == OBS_FRONTEND_EVENT_SCENE_COLLECTION_CHANGING)
        requests_resume_stream_audio();
}

bool obs_module_load(void)
{
    if (!tap_sockets_init()) {
        blog(LOG_ERROR, "[soundcheck] socket setup failed");
        return false;
    }
    register_voice_eq();
    register_voice_analyzer();
    obs_frontend_add_event_callback(on_frontend_event, nullptr);
    blog(LOG_INFO, "[soundcheck] module loaded (version %s)", PLUGIN_VERSION);
    return true;
}

// obs-websocket registers its vendor API during load, so vendors attach after all modules load.
void obs_module_post_load(void)
{
    g_vendor = obs_websocket_register_vendor("soundcheck");
    if (!g_vendor) {
        blog(LOG_WARNING, "[soundcheck] obs-websocket not available; app control disabled");
        return;
    }
    for (size_t i = 0; i < kRequestCount; i++) {
        obs_websocket_vendor_register_request(g_vendor, kRequestNames[i], on_vendor_request,
                                              const_cast<char *>(kRequestNames[i]));
    }
}

void obs_module_unload(void)
{
    obs_frontend_remove_event_callback(on_frontend_event, nullptr);
    requests_shutdown();
    tap_sockets_shutdown();
    blog(LOG_INFO, "[soundcheck] module unloaded");
}
