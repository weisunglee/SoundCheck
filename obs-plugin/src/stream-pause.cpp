#include "stream-pause.hpp"

#include <obs-module.h>
#include <unordered_set>

StreamPause::~StreamPause() { resume(); }

bool StreamPause::pause(const std::vector<int> &stream_tracks, int timeout_ms)
{
    // Join a watchdog left over from a pause that already ended.
    if (watchdog_.joinable() && !paused())
        watchdog_.join();

    std::lock_guard lock(mutex_);
    if (paused_)
        return false;

    uint32_t mask = 0;
    for (int t : stream_tracks)
        mask |= 1u << (t - 1);

    // Inputs plus the global desktop/mic devices from Settings → Audio.
    std::unordered_set<obs_source_t *> sources;
    obs_enum_sources(
        [](void *param, obs_source_t *source) {
            if (obs_source_t *ref = obs_source_get_ref(source))
                static_cast<std::unordered_set<obs_source_t *> *>(param)->insert(ref);
            return true;
        },
        &sources);
    for (uint32_t ch = 0; ch < MAX_CHANNELS; ch++) {
        if (obs_source_t *source = obs_get_output_source(ch)) {
            if (!sources.insert(source).second)
                obs_source_release(source);
        }
    }

    for (obs_source_t *source : sources) {
        if (obs_source_get_output_flags(source) & OBS_SOURCE_AUDIO) {
            uint32_t mixers = obs_source_get_audio_mixers(source);
            if (mixers & mask) {
                saved_.push_back({obs_source_get_weak_source(source), mixers});
                obs_source_set_audio_mixers(source, mixers & ~mask);
            }
        }
        obs_source_release(source);
    }

    paused_ = true;
    timeout_ = std::chrono::milliseconds(timeout_ms);
    deadline_ = std::chrono::steady_clock::now() + timeout_;
    watchdog_ = std::thread(&StreamPause::watch, this);
    blog(LOG_INFO, "[soundcheck] stream audio paused (%zu sources, timeout %d ms)", saved_.size(), timeout_ms);
    return true;
}

void StreamPause::heartbeat()
{
    std::lock_guard lock(mutex_);
    if (paused_)
        deadline_ = std::chrono::steady_clock::now() + timeout_;
}

void StreamPause::resume()
{
    {
        std::lock_guard lock(mutex_);
        if (paused_)
            restore_locked();
    }
    wake_.notify_all();
    if (watchdog_.joinable() && watchdog_.get_id() != std::this_thread::get_id())
        watchdog_.join();
}

bool StreamPause::paused()
{
    std::lock_guard lock(mutex_);
    return paused_;
}

void StreamPause::watch()
{
    std::unique_lock lock(mutex_);
    while (paused_) {
        if (wake_.wait_until(lock, deadline_) == std::cv_status::timeout &&
            std::chrono::steady_clock::now() >= deadline_ && paused_) {
            blog(LOG_WARNING, "[soundcheck] no heartbeat from the app; restoring stream audio");
            restore_locked();
        }
    }
}

void StreamPause::restore_locked()
{
    for (const Saved &s : saved_) {
        if (obs_source_t *source = obs_weak_source_get_source(s.source)) {
            obs_source_set_audio_mixers(source, s.mixers);
            obs_source_release(source);
        }
        obs_weak_source_release(s.source);
    }
    blog(LOG_INFO, "[soundcheck] stream audio restored (%zu sources)", saved_.size());
    saved_.clear();
    paused_ = false;
}
