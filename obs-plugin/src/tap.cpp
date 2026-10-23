#include "tap.hpp"

#include <media-io/audio-resampler.h>
#include <obs-module.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
static constexpr socket_handle kNoSocket = socket_handle(INVALID_SOCKET);
static void close_socket(socket_handle s) { closesocket(SOCKET(s)); }
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
static constexpr socket_handle kNoSocket = -1;
static void close_socket(socket_handle s) { close(s); }
#endif

/** About two seconds of audio; older blocks are dropped if the client falls behind. */
static constexpr size_t kMaxQueuedBlocks = 100;

/**
 * The `param` libobs passes back to the audio callback. Streamlabs' libobs reads every audio
 * callback's param as an obs_encoder to find its canvas, and skips it when `encoder->video` is
 * set; a zeroed block reads as an encoder without video, so it is neither skipped nor a crash.
 * Large enough to cover the fields it reads. Upstream libobs never looks inside.
 */
alignas(64) static unsigned char g_callback_param[64 * 1024];
/** The tap the callback belongs to; there is only ever one. */
static Tap *g_active_tap = nullptr;

bool tap_sockets_init()
{
#ifdef _WIN32
    WSADATA wsa;
    return WSAStartup(MAKEWORD(2, 2), &wsa) == 0;
#else
    return true;
#endif
}

void tap_sockets_shutdown()
{
#ifdef _WIN32
    WSACleanup();
#endif
}

Tap::~Tap() { stop(); }

uint16_t Tap::start(int track)
{
    stop();
    if (track < 1 || track > MAX_AUDIO_MIXES)
        return 0;

    socket_handle listener = socket_handle(socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
    if (listener == kNoSocket)
        return 0;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    socklen_t len = sizeof(addr);
    if (bind(listener, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 || listen(listener, 1) != 0 ||
        getsockname(listener, reinterpret_cast<sockaddr *>(&addr), &len) != 0) {
        close_socket(listener);
        return 0;
    }

    const audio_output_info *native = audio_output_get_info(obs_get_audio());
    resample_info from{native->samples_per_sec, native->format, native->speakers};
    resample_info to{kSampleRate, AUDIO_FORMAT_FLOAT, SPEAKERS_STEREO};
    resampler_ = audio_resampler_create(&to, &from);
    if (!resampler_) {
        close_socket(listener);
        return 0;
    }

    listener_ = listener;
    client_ = kNoSocket;
    track_ = track;
    last_timestamp_ = 0;
    stopping_ = false;
    client_connected_ = false;
    running_ = true;

    // No conversion: the mix arrives as libobs makes it, and resampler_ converts it.
    g_active_tap = this;
    obs_add_raw_audio_callback(size_t(track - 1), nullptr, &Tap::on_audio, g_callback_param);

    thread_ = std::thread(&Tap::serve, this);

    uint16_t port = ntohs(addr.sin_port);
    blog(LOG_INFO, "[soundcheck] tap started on track %d, port %u", track, port);
    return port;
}

void Tap::stop()
{
    if (!running_)
        return;

    // Once this returns, libobs makes no more calls to on_audio.
    obs_remove_raw_audio_callback(size_t(track_ - 1), &Tap::on_audio, g_callback_param);
    g_active_tap = nullptr;
    audio_resampler_destroy(resampler_);
    resampler_ = nullptr;

    stopping_ = true;
    close_socket(listener_);
    wake_.notify_all();
    if (thread_.joinable())
        thread_.join();

    {
        std::lock_guard lock(mutex_);
        queue_.clear();
    }
    running_ = false;
    blog(LOG_INFO, "[soundcheck] tap stopped");
}

void Tap::on_audio(void *, size_t, audio_data *data)
{
    Tap *self = g_active_tap;
    // Streamlabs sends the same moment once per canvas; the first one is the main canvas.
    if (!self || (self->last_timestamp_ != 0 && data->timestamp <= self->last_timestamp_))
        return;
    self->last_timestamp_ = data->timestamp;
    if (!data->data[0])
        return;

    uint8_t *converted[MAX_AV_PLANES] = {};
    uint32_t frames = 0;
    uint64_t offset = 0;
    if (!audio_resampler_resample(self->resampler_, converted, &frames, &offset, data->data, data->frames) ||
        !converted[0] || !self->client_connected_)
        return;

    const float *samples = reinterpret_cast<const float *>(converted[0]);
    std::vector<float> block(samples, samples + size_t(frames) * kChannels);

    {
        std::lock_guard lock(self->mutex_);
        if (self->queue_.size() >= kMaxQueuedBlocks)
            self->queue_.pop_front();
        self->queue_.push_back(std::move(block));
    }
    self->wake_.notify_one();
}

void Tap::serve()
{
    // Wait for the one client, checking regularly whether we are asked to stop.
    while (!stopping_) {
        fd_set readable;
        FD_ZERO(&readable);
        FD_SET(listener_, &readable);
        timeval timeout{0, 200 * 1000};
        int ready = select(int(listener_ + 1), &readable, nullptr, nullptr, &timeout);
        if (ready < 0)
            return;
        if (ready > 0) {
            client_ = socket_handle(accept(listener_, nullptr, nullptr));
            break;
        }
    }
    if (stopping_ || client_ == kNoSocket)
        return;

    client_connected_ = true;
    blog(LOG_INFO, "[soundcheck] tap client connected");

    while (!stopping_) {
        std::vector<float> block;
        {
            std::unique_lock lock(mutex_);
            wake_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
            if (stopping_)
                break;
            block = std::move(queue_.front());
            queue_.pop_front();
        }

        const char *bytes = reinterpret_cast<const char *>(block.data());
        size_t remaining = block.size() * sizeof(float);
        while (remaining > 0) {
            int sent = int(send(client_, bytes, int(remaining), 0));
            if (sent <= 0) {
                blog(LOG_INFO, "[soundcheck] tap client disconnected");
                client_connected_ = false;
                close_socket(client_);
                return;
            }
            bytes += sent;
            remaining -= size_t(sent);
        }
    }

    client_connected_ = false;
    close_socket(client_);
}
