// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

#include "source-meters.hpp"

#include <algorithm>
#include <cmath>
#include <obs-module.h>
#include <unordered_set>
#include <util/platform.h>

/** Look for added or removed sources at most this often. */
static constexpr uint64_t kSyncIntervalNs = 1000000000;
static constexpr int kChannels = 2;

struct SourceMeters::Meter {
    SourceMeters *owner;
    obs_weak_source_t *source;
    obs_volmeter_t *volmeter;
    std::string name;
    // Since the last read, in dBFS; guarded by owner->mutex_.
    float magnitude[kChannels];
    float peak[kChannels];
    float input_peak[kChannels];
    int channels;
};

static float to_mul(float db) { return std::isfinite(db) ? std::pow(10.0f, db / 20.0f) : 0.0f; }

static void clear(float (&values)[kChannels]) { std::fill(std::begin(values), std::end(values), -INFINITY); }

SourceMeters::SourceMeters() = default;
SourceMeters::~SourceMeters() { stop(); }

void SourceMeters::on_levels(void *param, const float magnitude[], const float peak[], const float input_peak[])
{
    auto *meter = static_cast<Meter *>(param);
    int channels = std::clamp(obs_volmeter_get_nr_channels(meter->volmeter), 1, kChannels);
    std::lock_guard lock(meter->owner->mutex_);
    meter->channels = channels;
    for (int ch = 0; ch < kChannels; ch++) {
        meter->magnitude[ch] = magnitude[ch];
        meter->peak[ch] = std::max(meter->peak[ch], peak[ch]);
        meter->input_peak[ch] = std::max(meter->input_peak[ch], input_peak[ch]);
    }
}

static std::unordered_set<obs_source_t *> audio_sources()
{
    // Inputs plus the global desktop/mic devices, each with a reference.
    std::unordered_set<obs_source_t *> sources;
    obs_enum_sources(
        [](void *param, obs_source_t *source) {
            if ((obs_source_get_output_flags(source) & OBS_SOURCE_AUDIO))
                if (obs_source_t *ref = obs_source_get_ref(source))
                    static_cast<std::unordered_set<obs_source_t *> *>(param)->insert(ref);
            return true;
        },
        &sources);
    for (uint32_t ch = 0; ch < MAX_CHANNELS; ch++) {
        if (obs_source_t *source = obs_get_output_source(ch)) {
            if (!(obs_source_get_output_flags(source) & OBS_SOURCE_AUDIO) || !sources.insert(source).second)
                obs_source_release(source);
        }
    }
    return sources;
}

void SourceMeters::sync()
{
    std::unordered_set<obs_source_t *> sources = audio_sources();

    // Drop meters whose source is gone.
    std::vector<std::unique_ptr<Meter>> gone;
    {
        std::lock_guard lock(mutex_);
        for (auto it = meters_.begin(); it != meters_.end();) {
            obs_source_t *source = obs_weak_source_get_source((*it)->source);
            bool alive = source && sources.count(source);
            obs_source_release(source);
            if (alive) {
                ++it;
            } else {
                gone.push_back(std::move(*it));
                it = meters_.erase(it);
            }
        }
    }
    for (auto &meter : gone) {
        obs_volmeter_remove_callback(meter->volmeter, on_levels, meter.get());
        obs_volmeter_destroy(meter->volmeter);
        obs_weak_source_release(meter->source);
    }

    for (obs_source_t *source : sources) {
        bool known;
        {
            std::lock_guard lock(mutex_);
            known = std::any_of(meters_.begin(), meters_.end(),
                                [&](const auto &m) { return obs_weak_source_references_source(m->source, source); });
        }
        if (!known) {
            auto meter = std::make_unique<Meter>();
            meter->owner = this;
            meter->source = obs_source_get_weak_source(source);
            meter->name = obs_source_get_name(source);
            meter->channels = kChannels;
            clear(meter->magnitude);
            clear(meter->peak);
            clear(meter->input_peak);
            meter->volmeter = obs_volmeter_create(OBS_FADER_LOG);
            obs_volmeter_attach_source(meter->volmeter, source);
            Meter *raw = meter.get();
            {
                std::lock_guard lock(mutex_);
                meters_.push_back(std::move(meter));
            }
            obs_volmeter_add_callback(raw->volmeter, on_levels, raw);
        }
        obs_source_release(source);
    }
}

void SourceMeters::read(obs_data_t *response)
{
    uint64_t now = os_gettime_ns();
    if (last_sync_ns_ == 0 || now - last_sync_ns_ >= kSyncIntervalNs) {
        sync();
        last_sync_ns_ = now;
    }

    obs_data_array_t *inputs = obs_data_array_create();
    {
        std::lock_guard lock(mutex_);
        for (auto &meter : meters_) {
            obs_data_array_t *levels = obs_data_array_create();
            for (int ch = 0; ch < meter->channels; ch++) {
                obs_data_t *channel = obs_data_create();
                obs_data_set_double(channel, "magnitude", to_mul(meter->magnitude[ch]));
                obs_data_set_double(channel, "peak", to_mul(meter->peak[ch]));
                obs_data_set_double(channel, "inputPeak", to_mul(meter->input_peak[ch]));
                obs_data_array_push_back(levels, channel);
                obs_data_release(channel);
            }
            clear(meter->peak);
            clear(meter->input_peak);

            obs_data_t *input = obs_data_create();
            obs_data_set_string(input, "name", meter->name.c_str());
            obs_data_set_array(input, "levels", levels);
            obs_data_array_push_back(inputs, input);
            obs_data_release(input);
            obs_data_array_release(levels);
        }
    }
    obs_data_set_bool(response, "ok", true);
    obs_data_set_array(response, "inputs", inputs);
    obs_data_array_release(inputs);
}

void SourceMeters::stop()
{
    std::vector<std::unique_ptr<Meter>> all;
    {
        std::lock_guard lock(mutex_);
        all.swap(meters_);
    }
    for (auto &meter : all) {
        obs_volmeter_remove_callback(meter->volmeter, on_levels, meter.get());
        obs_volmeter_destroy(meter->volmeter);
        obs_weak_source_release(meter->source);
    }
    last_sync_ns_ = 0;
}
