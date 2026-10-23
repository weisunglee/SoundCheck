#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

struct audio_data;
struct audio_resampler;

#ifdef _WIN32
using socket_handle = uintptr_t;
#else
using socket_handle = int;
#endif

/**
 * Copies one OBS audio track's mix to a single local TCP client as raw
 * interleaved 32-bit float stereo PCM at 48 kHz.
 *
 * The tap only reads the mix; it never feeds audio back into OBS. It takes the
 * mix as libobs makes it and converts it itself, because Streamlabs' libobs
 * delivers each mix once per canvas (horizontal and vertical output): a shared
 * libobs converter would be fed both, so the tap keeps only the first block of
 * each moment, which is the main canvas.
 */
class Tap {
public:
    static constexpr uint32_t kSampleRate = 48000;
    static constexpr uint32_t kChannels = 2;

    Tap() = default;
    ~Tap();
    Tap(const Tap &) = delete;
    Tap &operator=(const Tap &) = delete;

    /** Starts listening on 127.0.0.1 for `track` (1-6). Returns the port, or 0 on failure. */
    uint16_t start(int track);
    void stop();
    bool running() const { return running_; }
    int track() const { return track_; }

private:
    static void on_audio(void *param, size_t mix_idx, audio_data *data);
    void serve();

    std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<std::vector<float>> queue_;
    std::thread thread_;
    std::atomic<bool> stopping_{false};
    std::atomic<bool> client_connected_{false};
    audio_resampler *resampler_ = nullptr;
    /** Timestamp of the last block taken, to drop the other canvases' copies. */
    uint64_t last_timestamp_ = 0;
    bool running_ = false;
    int track_ = 0;
    socket_handle listener_;
    socket_handle client_;
};

/** One-time socket library setup (Winsock on Windows). */
bool tap_sockets_init();
void tap_sockets_shutdown();
