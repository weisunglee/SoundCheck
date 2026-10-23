// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

struct obs_weak_source;
typedef struct obs_weak_source obs_weak_source_t;

/**
 * Temporarily takes every audio source off the stream tracks, so the stream
 * goes silent while the app plays a sound-test recording, then puts each
 * source's track selection back exactly as it was.
 *
 * The app must call heartbeat() regularly; if it stops (crash, disconnect),
 * the watchdog restores the tracks by itself after the timeout.
 */
class StreamPause {
public:
    ~StreamPause();

    /** Returns false if already paused. */
    bool pause(const std::vector<int> &stream_tracks, int timeout_ms);
    void heartbeat();
    void resume();
    bool paused();

private:
    struct Saved {
        obs_weak_source_t *source;
        uint32_t mixers;
    };

    void watch();
    void restore_locked();

    std::mutex mutex_;
    std::condition_variable wake_;
    std::thread watchdog_;
    std::vector<Saved> saved_;
    std::chrono::milliseconds timeout_{0};
    std::chrono::steady_clock::time_point deadline_;
    bool paused_ = false;
};
