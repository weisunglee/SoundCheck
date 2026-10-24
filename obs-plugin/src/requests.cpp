// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

#include "requests.hpp"

#include <cstring>
#include <obs-module.h>

#include "source-meters.hpp"
#include "stream-pause.hpp"
#include "tap.hpp"
#include "voice-filters.hpp"

static Tap g_tap;
static StreamPause g_pause;
static SourceMeters g_meters;

const char *const kRequestNames[] = {"GetInfo", "StartTap", "StopTap", "PauseStreamAudio", "Heartbeat", "ResumeStreamAudio", "GetSourceLevels",
                                     "StartVoiceCapture", "ReadVoiceCapture", "StopVoiceCapture"};
const size_t kRequestCount = sizeof(kRequestNames) / sizeof(kRequestNames[0]);

static void set_error(obs_data_t *response, const char *message)
{
    obs_data_set_bool(response, "ok", false);
    obs_data_set_string(response, "error", message);
}

// "GetInfo": which tracks go to the stream, and the tap state.
static void get_info(const Host &host, obs_data_t *, obs_data_t *response)
{
    StreamTracks stream = host.stream_tracks();
    obs_data_array_t *tracks = obs_data_array_create();
    for (int t : stream.tracks) {
        obs_data_t *item = obs_data_create();
        obs_data_set_int(item, "track", t);
        obs_data_array_push_back(tracks, item);
        obs_data_release(item);
    }

    obs_data_set_bool(response, "ok", true);
    obs_data_set_string(response, "pluginVersion", PLUGIN_VERSION);
    obs_data_set_bool(response, "streaming", host.streaming());
    obs_data_set_array(response, "streamTracks", tracks);
    obs_data_set_string(response, "streamTracksOrigin", stream.origin.c_str());
    obs_data_set_bool(response, "tapRunning", g_tap.running());
    obs_data_set_bool(response, "streamAudioPaused", g_pause.paused());
    obs_data_array_release(tracks);
}

// "StartTap" { track?: 1-6 }: defaults to the first stream track.
static void start_tap(const Host &host, obs_data_t *request, obs_data_t *response)
{
    int track = int(obs_data_get_int(request, "track"));
    if (track == 0)
        track = host.stream_tracks().tracks.front();

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

static void stop_tap(const Host &, obs_data_t *, obs_data_t *response)
{
    g_tap.stop();
    obs_data_set_bool(response, "ok", true);
}

// "PauseStreamAudio" { timeoutMs?: number }: silences the stream tracks until
// "ResumeStreamAudio", or until no "Heartbeat" arrives within the timeout.
static void pause_stream_audio(const Host &host, obs_data_t *request, obs_data_t *response)
{
    int timeout_ms = int(obs_data_get_int(request, "timeoutMs"));
    if (timeout_ms <= 0)
        timeout_ms = 3000;

    if (!g_pause.pause(host.stream_tracks().tracks, timeout_ms)) {
        set_error(response, "stream audio is already paused");
        return;
    }
    obs_data_set_bool(response, "ok", true);
}

static void heartbeat(const Host &, obs_data_t *, obs_data_t *response)
{
    g_pause.heartbeat();
    obs_data_set_bool(response, "ok", true);
    obs_data_set_bool(response, "streamAudioPaused", g_pause.paused());
}

static void resume_stream_audio(const Host &, obs_data_t *, obs_data_t *response)
{
    g_pause.resume();
    obs_data_set_bool(response, "ok", true);
}

// "GetSourceLevels": every audio source's levels since the last call (see source-meters.hpp).
static void get_source_levels(const Host &, obs_data_t *, obs_data_t *response)
{
    g_meters.read(response);
}

// The voice analyzer's requests (see voice-filters.hpp).
static void start_voice_capture(const Host &, obs_data_t *request, obs_data_t *response)
{
    voice_capture_start(request, response);
}

static void read_voice_capture(const Host &, obs_data_t *request, obs_data_t *response)
{
    voice_capture_read(request, response);
}

static void stop_voice_capture(const Host &, obs_data_t *request, obs_data_t *response)
{
    voice_capture_stop(request, response);
}

using Handler = void (*)(const Host &, obs_data_t *, obs_data_t *);
static const Handler kHandlers[] = {get_info,           start_tap,          stop_tap,         pause_stream_audio,
                                    heartbeat,          resume_stream_audio, get_source_levels, start_voice_capture,
                                    read_voice_capture, stop_voice_capture};
static_assert(sizeof(kHandlers) / sizeof(kHandlers[0]) == sizeof(kRequestNames) / sizeof(kRequestNames[0]));

bool handle_request(const Host &host, const char *type, obs_data_t *request, obs_data_t *response)
{
    for (size_t i = 0; i < kRequestCount; i++) {
        if (type && std::strcmp(type, kRequestNames[i]) == 0) {
            kHandlers[i](host, request, response);
            return true;
        }
    }
    set_error(response, "unknown request");
    return false;
}

void requests_resume_stream_audio()
{
    g_pause.resume();
}

void requests_shutdown()
{
    g_pause.resume();
    g_tap.stop();
    g_meters.stop();
}
