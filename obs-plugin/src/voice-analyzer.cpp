// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

// "SoundCheck Voice Analyzer": a pass-through filter that records what reaches it. libobs runs a
// source's filters before handing its audio to anyone else, so the only way to hear a mic before
// its filters is to be the first one of them.
#include "voice-filters.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>
#include <obs-module.h>

namespace {

/** Longest recording, and the most one read returns (the app reads several times a second). */
constexpr double kMaxSeconds = 30;
constexpr double kMaxReadSeconds = 1;

struct Analyzer {
    obs_source_t *context;
    std::mutex mutex;
    std::vector<float> samples;
    size_t target = 0;
    uint32_t rate = 0;
    bool capturing = false;
};

// Requests find analyzers here. A request holds the lock for as long as it uses one, and
// destroy() takes it out first, so an analyzer is never used after it is gone.
std::mutex g_registry_mutex;
std::vector<Analyzer *> g_analyzers;

const char *get_name(void *) { return "SoundCheck Voice Analyzer"; }

void *create(obs_data_t *, obs_source_t *context)
{
    auto *a = new Analyzer;
    a->context = context;
    std::lock_guard lock(g_registry_mutex);
    g_analyzers.push_back(a);
    return a;
}

void destroy(void *data)
{
    auto *a = static_cast<Analyzer *>(data);
    {
        std::lock_guard lock(g_registry_mutex);
        g_analyzers.erase(std::remove(g_analyzers.begin(), g_analyzers.end(), a), g_analyzers.end());
    }
    delete a;
}

obs_audio_data *filter_audio(void *data, obs_audio_data *audio)
{
    auto *a = static_cast<Analyzer *>(data);
    std::lock_guard lock(a->mutex);
    if (!a->capturing)
        return audio;

    // Mono: the mean of the channels that carry audio.
    size_t channels = std::min<size_t>(audio_output_get_channels(obs_get_audio()), MAX_AUDIO_CHANNELS);
    const float *planes[MAX_AUDIO_CHANNELS];
    size_t used = 0;
    for (size_t c = 0; c < channels; c++)
        if (audio->data[c])
            planes[used++] = reinterpret_cast<const float *>(audio->data[c]);
    if (used == 0)
        return audio;

    size_t frames = std::min<size_t>(audio->frames, a->target - a->samples.size());
    for (size_t i = 0; i < frames; i++) {
        float sum = 0;
        for (size_t c = 0; c < used; c++)
            sum += planes[c][i];
        a->samples.push_back(sum / float(used));
    }
    if (a->samples.size() >= a->target)
        a->capturing = false;
    return audio;
}

/** The analyzer on the source named `name`; call with g_registry_mutex held. */
Analyzer *find(const char *name)
{
    if (!name || !*name)
        return nullptr;
    for (Analyzer *a : g_analyzers) {
        obs_source_t *parent = obs_filter_get_parent(a->context);
        if (parent && std::strcmp(obs_source_get_name(parent), name) == 0)
            return a;
    }
    return nullptr;
}

void set_error(obs_data_t *response, const char *message)
{
    obs_data_set_bool(response, "ok", false);
    obs_data_set_string(response, "error", message);
}

std::string base64(const unsigned char *bytes, size_t n)
{
    static const char kTable[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((n + 2) / 3 * 4);
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = uint32_t(bytes[i]) << 16;
        if (i + 1 < n)
            v |= uint32_t(bytes[i + 1]) << 8;
        if (i + 2 < n)
            v |= bytes[i + 2];
        out += kTable[(v >> 18) & 63];
        out += kTable[(v >> 12) & 63];
        out += i + 1 < n ? kTable[(v >> 6) & 63] : '=';
        out += i + 2 < n ? kTable[v & 63] : '=';
    }
    return out;
}

} // namespace

void register_voice_analyzer()
{
    obs_source_info info = {};
    info.id = "soundcheck_voice_analyzer";
    info.type = OBS_SOURCE_TYPE_FILTER;
    info.output_flags = OBS_SOURCE_AUDIO;
    info.get_name = get_name;
    info.create = create;
    info.destroy = destroy;
    info.filter_audio = filter_audio;
    obs_register_source(&info);
}

void voice_capture_start(obs_data_t *request, obs_data_t *response)
{
    std::lock_guard registry(g_registry_mutex);
    Analyzer *a = find(obs_data_get_string(request, "source"));
    if (!a) {
        set_error(response, "no analyzer on that source");
        return;
    }
    double seconds = std::clamp(obs_data_get_double(request, "seconds"), 1.0, kMaxSeconds);
    uint32_t rate = audio_output_get_sample_rate(obs_get_audio());

    std::lock_guard lock(a->mutex);
    a->rate = rate;
    a->target = size_t(seconds * rate);
    a->samples.clear();
    a->samples.reserve(a->target);
    a->capturing = true;
    obs_data_set_bool(response, "ok", true);
    obs_data_set_int(response, "sampleRate", rate);
}

void voice_capture_read(obs_data_t *request, obs_data_t *response)
{
    std::lock_guard registry(g_registry_mutex);
    Analyzer *a = find(obs_data_get_string(request, "source"));
    if (!a) {
        set_error(response, "no analyzer on that source");
        return;
    }
    size_t from = size_t(std::max<long long>(0, obs_data_get_int(request, "from")));

    std::lock_guard lock(a->mutex);
    size_t total = a->samples.size();
    from = std::min(from, total);
    size_t count = std::min(total - from, size_t(kMaxReadSeconds * a->rate));
    float peak = 0;
    for (size_t i = from; i < from + count; i++)
        peak = std::max(peak, std::fabs(a->samples[i]));

    // libobs targets are little-endian, so the floats' bytes go out as they are.
    std::string data = base64(reinterpret_cast<const unsigned char *>(a->samples.data() + from), count * sizeof(float));
    obs_data_set_bool(response, "ok", true);
    obs_data_set_bool(response, "capturing", a->capturing);
    obs_data_set_int(response, "sampleRate", a->rate);
    obs_data_set_int(response, "from", int64_t(from));
    obs_data_set_int(response, "frames", int64_t(count));
    obs_data_set_int(response, "total", int64_t(total));
    obs_data_set_int(response, "target", int64_t(a->target));
    obs_data_set_double(response, "peak", peak);
    obs_data_set_string(response, "data", data.c_str());
}

void voice_capture_stop(obs_data_t *request, obs_data_t *response)
{
    std::lock_guard registry(g_registry_mutex);
    if (Analyzer *a = find(obs_data_get_string(request, "source"))) {
        std::lock_guard lock(a->mutex);
        a->capturing = false;
        a->samples.clear();
        a->samples.shrink_to_fit();
    }
    obs_data_set_bool(response, "ok", true);
}
