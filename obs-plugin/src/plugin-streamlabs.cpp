// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

// The plugin as loaded by Streamlabs Desktop (its user plugin folder, loaded on request through
// ObsUserPluginsService.initializeModule). Streamlabs has neither obs-websocket nor OBS's
// frontend API, so the app reaches the plugin through a control port of its own:
//
// - On load the plugin listens on 127.0.0.1 and writes {"port", "token", "pluginVersion"} to
//   control.json in the module's data folder.
// - The app connects and sends one JSON line per request:
//     {"token": "...", "requestType": "GetInfo", "requestData": {...}}
//   and gets one JSON line back, the same response the OBS build gives to a vendor request.
#include <obs-module.h>
#include <util/platform.h>

#include <atomic>
#include <cstring>
#include <random>
#include <string>
#include <thread>

#include "requests.hpp"
#include "tap.hpp"

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using native_socket = SOCKET;
static constexpr native_socket kNoSocket = INVALID_SOCKET;
static void close_native(native_socket s) { closesocket(s); }
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
using native_socket = int;
static constexpr native_socket kNoSocket = -1;
static void close_native(native_socket s) { close(s); }
#endif

OBS_DECLARE_MODULE()

extern "C" const char *obs_module_name(void) { return "SoundCheck"; }
extern "C" const char *obs_module_description(void)
{
    return "Companion for the SoundCheck app: lets it listen to the stream mix.";
}

static const Host kHost = {get_stream_tracks_from_outputs, stream_output_active};

/** A request line longer than this is not from the app. */
static constexpr size_t kMaxLine = 64 * 1024;
/** A connection that sends nothing for this long is closed, so unloading never waits on it. */
static constexpr int kIdleMs = 5000;

static native_socket g_listener = kNoSocket;
static std::thread g_server;
static std::atomic<bool> g_stopping{false};
static std::string g_token;
static std::string g_control_path;

static std::string random_token()
{
    std::random_device random;
    static const char kHex[] = "0123456789abcdef";
    std::string token;
    for (int i = 0; i < 32; i++)
        token += kHex[random() % 16];
    return token;
}

/** Answers one request line; the answer is a JSON object without a trailing newline. */
static std::string answer(const std::string &line)
{
    obs_data_t *request = obs_data_create_from_json(line.c_str());
    obs_data_t *response = obs_data_create();
    if (!request) {
        obs_data_set_bool(response, "ok", false);
        obs_data_set_string(response, "error", "not JSON");
    } else if (g_token != obs_data_get_string(request, "token")) {
        obs_data_set_bool(response, "ok", false);
        obs_data_set_string(response, "error", "wrong token");
    } else {
        obs_data_t *data = obs_data_get_obj(request, "requestData");
        if (!data)
            data = obs_data_create();
        handle_request(kHost, obs_data_get_string(request, "requestType"), data, response);
        obs_data_release(data);
    }
    std::string json = obs_data_get_json(response);
    obs_data_release(response);
    obs_data_release(request);
    return json;
}

/** Serves one connection: request lines in, answer lines out, until the app closes it. */
static void serve_client(native_socket client)
{
    std::string buffer;
    char chunk[4096];
    while (!g_stopping) {
        int got = int(recv(client, chunk, int(sizeof(chunk)), 0));
        if (got <= 0)
            break;
        buffer.append(chunk, size_t(got));
        size_t newline;
        while ((newline = buffer.find('\n')) != std::string::npos) {
            std::string reply = answer(buffer.substr(0, newline)) + "\n";
            buffer.erase(0, newline + 1);
            const char *bytes = reply.data();
            size_t remaining = reply.size();
            while (remaining > 0) {
                int sent = int(send(client, bytes, int(remaining), 0));
                if (sent <= 0)
                    return;
                bytes += sent;
                remaining -= size_t(sent);
            }
        }
        if (buffer.size() > kMaxLine)
            break;
    }
}

static void serve()
{
    while (!g_stopping) {
        fd_set readable;
        FD_ZERO(&readable);
        FD_SET(g_listener, &readable);
        timeval timeout{0, 200 * 1000};
        int ready = select(int(g_listener + 1), &readable, nullptr, nullptr, &timeout);
        if (ready < 0)
            return;
        if (ready == 0)
            continue;
        native_socket client = accept(g_listener, nullptr, nullptr);
        if (client == kNoSocket)
            continue;
#ifdef _WIN32
        DWORD idle = kIdleMs;
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&idle), sizeof(idle));
#else
        timeval idle{kIdleMs / 1000, 0};
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &idle, sizeof(idle));
#endif
        // One app request at a time; the app opens a short connection per request.
        serve_client(client);
        close_native(client);
    }
}

/** Opens the control port; returns it, or 0 on failure. */
static uint16_t listen_control()
{
    native_socket listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == kNoSocket)
        return 0;
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    socklen_t len = sizeof(addr);
    if (bind(listener, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 || listen(listener, 4) != 0 ||
        getsockname(listener, reinterpret_cast<sockaddr *>(&addr), &len) != 0) {
        close_native(listener);
        return 0;
    }
    g_listener = listener;
    return ntohs(addr.sin_port);
}

static bool write_control_file(uint16_t port)
{
    char *dir = obs_module_get_config_path(obs_current_module(), "");
    const char *data_dir = obs_get_module_data_path(obs_current_module());
    // Streamlabs gives each user plugin a data folder; fall back to the config path otherwise.
    std::string folder = data_dir && *data_dir ? data_dir : (dir ? dir : "");
    bfree(dir);
    if (folder.empty())
        return false;
    os_mkdirs(folder.c_str());
    g_control_path = folder + "/control.json";

    obs_data_t *control = obs_data_create();
    obs_data_set_int(control, "port", port);
    obs_data_set_string(control, "token", g_token.c_str());
    obs_data_set_string(control, "pluginVersion", PLUGIN_VERSION);
    const char *json = obs_data_get_json(control);
    bool ok = os_quick_write_utf8_file(g_control_path.c_str(), json, strlen(json), false);
    obs_data_release(control);
    return ok;
}

bool obs_module_load(void)
{
    if (!tap_sockets_init()) {
        blog(LOG_ERROR, "[soundcheck] socket setup failed");
        return false;
    }
    g_token = random_token();
    uint16_t port = listen_control();
    if (port == 0 || !write_control_file(port)) {
        blog(LOG_ERROR, "[soundcheck] could not open the control port");
        if (g_listener != kNoSocket)
            close_native(g_listener);
        g_listener = kNoSocket;
        return false;
    }
    g_stopping = false;
    g_server = std::thread(serve);
    blog(LOG_INFO, "[soundcheck] module loaded for Streamlabs (version %s), control port %u, %s", PLUGIN_VERSION, port,
         g_control_path.c_str());
    return true;
}

void obs_module_unload(void)
{
    g_stopping = true;
    if (g_listener != kNoSocket)
        close_native(g_listener);
    if (g_server.joinable())
        g_server.join();
    g_listener = kNoSocket;
    if (!g_control_path.empty())
        os_unlink(g_control_path.c_str());
    requests_shutdown();
    tap_sockets_shutdown();
    blog(LOG_INFO, "[soundcheck] module unloaded");
}
