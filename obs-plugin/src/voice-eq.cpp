// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

// "SoundCheck Voice EQ": the EQ OBS doesn't have built in. A high-pass, two peaking bands (one for
// "mud", one for "presence"), a high shelf ("air") and an optional de-esser, each off at its
// neutral setting. The app's voice tuning sets it through the filter settings; the keys below are
// the contract (src/voiceTuning.ts writes them).
#include "voice-filters.hpp"

#include <algorithm>
#include <cmath>
#include <mutex>
#include <obs-module.h>

#include "biquad.hpp"

namespace {

struct Params {
    double hpf_freq = 0; // 0 = off
    double mud_freq = 300, mud_gain = 0, mud_q = 1.4;
    double presence_freq = 3000, presence_gain = 0, presence_q = 1.0;
    double air_freq = 10000, air_gain = 0;
    bool deess = false;
    double deess_freq = 6500, deess_threshold = -30, deess_max_reduction = 6;
};

/** Butterworth Qs of a 4th-order (24 dB/octave) high-pass made of two sections. */
constexpr double kHighpassQ[2] = {0.54119610, 1.30656296};
constexpr double kDeessQ = 2.0;
/** De-esser envelope times. */
constexpr double kDeessAttackMs = 1.0, kDeessReleaseMs = 60.0;

struct Channel {
    Biquad hpf[2], mud, presence, air, sibilance;
    double envelope = 0, gain = 1;
};

struct VoiceEq {
    obs_source_t *context;
    std::mutex mutex;
    Params pending;
    bool dirty = true;

    // Audio-thread state.
    Params params;
    uint32_t rate = 0;
    Channel channels[MAX_AUDIO_CHANNELS];
    double attack = 0, release = 0;

    void design()
    {
        double nyquist = rate / 2.0;
        auto clamp_f = [&](double f) { return std::clamp(f, 10.0, nyquist * 0.9); };
        for (Channel &ch : channels) {
            for (int i = 0; i < 2; i++)
                ch.hpf[i].highpass(rate, clamp_f(params.hpf_freq > 0 ? params.hpf_freq : 20), kHighpassQ[i]);
            ch.mud.peak(rate, clamp_f(params.mud_freq), params.mud_gain, std::max(0.1, params.mud_q));
            ch.presence.peak(rate, clamp_f(params.presence_freq), params.presence_gain, std::max(0.1, params.presence_q));
            ch.air.high_shelf(rate, clamp_f(params.air_freq), params.air_gain);
            ch.sibilance.bandpass(rate, clamp_f(params.deess_freq), kDeessQ);
        }
        attack = std::exp(-1.0 / (kDeessAttackMs * 0.001 * rate));
        release = std::exp(-1.0 / (kDeessReleaseMs * 0.001 * rate));
    }

    void reset()
    {
        for (Channel &ch : channels) {
            for (Biquad &b : ch.hpf)
                b.reset();
            ch.mud.reset();
            ch.presence.reset();
            ch.air.reset();
            ch.sibilance.reset();
            ch.envelope = 0;
            ch.gain = 1;
        }
    }
};

Params read_params(obs_data_t *s)
{
    Params p;
    p.hpf_freq = obs_data_get_double(s, "hpf_freq");
    p.mud_freq = obs_data_get_double(s, "mud_freq");
    p.mud_gain = obs_data_get_double(s, "mud_gain");
    p.mud_q = obs_data_get_double(s, "mud_q");
    p.presence_freq = obs_data_get_double(s, "presence_freq");
    p.presence_gain = obs_data_get_double(s, "presence_gain");
    p.presence_q = obs_data_get_double(s, "presence_q");
    p.air_freq = obs_data_get_double(s, "air_freq");
    p.air_gain = obs_data_get_double(s, "air_gain");
    p.deess = obs_data_get_bool(s, "deess_enabled");
    p.deess_freq = obs_data_get_double(s, "deess_freq");
    p.deess_threshold = obs_data_get_double(s, "deess_threshold");
    p.deess_max_reduction = obs_data_get_double(s, "deess_max_reduction");
    return p;
}

const char *get_name(void *) { return "SoundCheck Voice EQ"; }

void update(void *data, obs_data_t *settings)
{
    auto *eq = static_cast<VoiceEq *>(data);
    Params p = read_params(settings);
    std::lock_guard lock(eq->mutex);
    eq->pending = p;
    eq->dirty = true;
}

void *create(obs_data_t *settings, obs_source_t *context)
{
    auto *eq = new VoiceEq;
    eq->context = context;
    update(eq, settings);
    return eq;
}

void destroy(void *data) { delete static_cast<VoiceEq *>(data); }

void get_defaults(obs_data_t *s)
{
    Params p;
    obs_data_set_default_double(s, "hpf_freq", p.hpf_freq);
    obs_data_set_default_double(s, "mud_freq", p.mud_freq);
    obs_data_set_default_double(s, "mud_gain", p.mud_gain);
    obs_data_set_default_double(s, "mud_q", p.mud_q);
    obs_data_set_default_double(s, "presence_freq", p.presence_freq);
    obs_data_set_default_double(s, "presence_gain", p.presence_gain);
    obs_data_set_default_double(s, "presence_q", p.presence_q);
    obs_data_set_default_double(s, "air_freq", p.air_freq);
    obs_data_set_default_double(s, "air_gain", p.air_gain);
    obs_data_set_default_bool(s, "deess_enabled", p.deess);
    obs_data_set_default_double(s, "deess_freq", p.deess_freq);
    obs_data_set_default_double(s, "deess_threshold", p.deess_threshold);
    obs_data_set_default_double(s, "deess_max_reduction", p.deess_max_reduction);
}

// Shown in the program's own filter window; SoundCheck itself has a plain-language editor.
obs_properties_t *get_properties(void *)
{
    obs_properties_t *props = obs_properties_create();
    auto slider = [&](const char *key, const char *label, double min, double max, double step, const char *suffix) {
        obs_property_t *p = obs_properties_add_float_slider(props, key, label, min, max, step);
        obs_property_float_set_suffix(p, suffix);
    };
    slider("hpf_freq", "High-pass (0 = off)", 0, 300, 1, " Hz");
    slider("mud_freq", "Mud frequency", 100, 1000, 1, " Hz");
    slider("mud_gain", "Mud gain", -12, 12, 0.1, " dB");
    slider("mud_q", "Mud Q", 0.3, 6, 0.1, "");
    slider("presence_freq", "Presence frequency", 1000, 8000, 10, " Hz");
    slider("presence_gain", "Presence gain", -12, 12, 0.1, " dB");
    slider("presence_q", "Presence Q", 0.3, 6, 0.1, "");
    slider("air_freq", "Air shelf frequency", 4000, 16000, 100, " Hz");
    slider("air_gain", "Air shelf gain", -12, 12, 0.1, " dB");
    obs_properties_add_bool(props, "deess_enabled", "De-esser");
    slider("deess_freq", "De-esser frequency", 4000, 10000, 10, " Hz");
    slider("deess_threshold", "De-esser threshold", -60, 0, 0.5, " dB");
    slider("deess_max_reduction", "De-esser max reduction", 0, 20, 0.5, " dB");
    return props;
}

obs_audio_data *filter_audio(void *data, obs_audio_data *audio)
{
    auto *eq = static_cast<VoiceEq *>(data);
    uint32_t rate = audio_output_get_sample_rate(obs_get_audio());
    size_t channels = std::min<size_t>(audio_output_get_channels(obs_get_audio()), MAX_AUDIO_CHANNELS);
    {
        std::lock_guard lock(eq->mutex);
        if (eq->dirty || rate != eq->rate) {
            bool rate_changed = rate != eq->rate;
            eq->params = eq->pending;
            eq->rate = rate;
            eq->dirty = false;
            eq->design();
            if (rate_changed)
                eq->reset();
        }
    }

    const Params &p = eq->params;
    const bool hpf = p.hpf_freq > 0, mud = p.mud_gain != 0, presence = p.presence_gain != 0, air = p.air_gain != 0;
    const double threshold = std::pow(10.0, p.deess_threshold / 20);
    const double floor_gain = std::pow(10.0, -std::max(0.0, p.deess_max_reduction) / 20);

    for (size_t c = 0; c < channels; c++) {
        float *samples = reinterpret_cast<float *>(audio->data[c]);
        if (!samples)
            continue;
        Channel &ch = eq->channels[c];
        for (uint32_t i = 0; i < audio->frames; i++) {
            float x = samples[i];
            if (hpf)
                x = ch.hpf[1].process(ch.hpf[0].process(x));
            if (mud)
                x = ch.mud.process(x);
            if (presence)
                x = ch.presence.process(x);
            if (air)
                x = ch.air.process(x);
            if (p.deess) {
                // Split off the sibilance band and turn it down by how far it goes over the
                // threshold (2:1), never more than the maximum reduction.
                float band = ch.sibilance.process(x);
                double level = std::fabs(band);
                double coeff = level > ch.envelope ? eq->attack : eq->release;
                ch.envelope = coeff * ch.envelope + (1 - coeff) * level;
                double target = ch.envelope > threshold ? std::sqrt(threshold / ch.envelope) : 1.0;
                target = std::max(target, floor_gain);
                ch.gain += (target - ch.gain) * 0.01;
                x -= float((1 - ch.gain) * band);
            }
            samples[i] = x;
        }
    }
    return audio;
}

} // namespace

void register_voice_eq()
{
    obs_source_info info = {};
    info.id = "soundcheck_voice_eq";
    info.type = OBS_SOURCE_TYPE_FILTER;
    info.output_flags = OBS_SOURCE_AUDIO;
    info.get_name = get_name;
    info.create = create;
    info.destroy = destroy;
    info.update = update;
    info.get_defaults = get_defaults;
    info.get_properties = get_properties;
    info.filter_audio = filter_audio;
    obs_register_source(&info);
}
