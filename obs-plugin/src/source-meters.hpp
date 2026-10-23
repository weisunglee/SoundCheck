// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

struct obs_data;
typedef struct obs_data obs_data_t;
struct obs_volmeter;
struct obs_weak_source;

/**
 * Level meters for every audio source, for programs that don't report levels to the app
 * themselves (Streamlabs). Uses libobs's own volume meter, like the programs' mixers do.
 * Metering starts with the first read and follows sources being added and removed.
 */
class SourceMeters {
public:
    SourceMeters();
    ~SourceMeters();

    /**
     * Writes "inputs": [{"name", "levels": [{"magnitude", "peak", "inputPeak"} per channel]}]:
     * the latest magnitude and the highest peaks since the last read, as 0..1 multipliers like
     * obs-websocket's InputVolumeMeters event. "name" is the libobs source name.
     */
    void read(obs_data_t *response);
    void stop();

private:
    struct Meter;
    static void on_levels(void *param, const float magnitude[], const float peak[], const float input_peak[]);
    void sync();

    std::mutex mutex_;
    std::vector<std::unique_ptr<Meter>> meters_;
    uint64_t last_sync_ns_ = 0;
};
