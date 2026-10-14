/* Independent executable adapter for the generic sample, not an upstream MUD. */
#define _POSIX_C_SOURCE 200809L
#include "discord_bridge.h"
#include <cjson/cJSON.h>
#include <assert.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int write_mode, read_mode, send_calls, recv_calls;
static int max_send_calls, max_recv_calls;
static size_t sent_bytes, read_bytes, max_sent_bytes, max_read_bytes;
static unsigned long send_sequence;

ssize_t __real_send(int fd, const void *data, size_t bytes, int flags);
ssize_t __real_recv(int fd, void *data, size_t bytes, int flags);
ssize_t __wrap_send(int fd, const void *data, size_t bytes, int flags) {
    ssize_t result;
    ++send_calls;
    ++send_sequence;
    if (write_mode == 2 || (write_mode == 1 && send_sequence % 7 == 0)) { errno = EAGAIN; return -1; }
    if (write_mode == 4 || (write_mode == 1 && send_sequence % 5 == 0)) { errno = EINTR; return -1; }
    if (write_mode == 3) { errno = EPIPE; return -1; }
    if (write_mode == 1 && bytes > 17) bytes = 17;
    result = __real_send(fd, data, bytes, flags);
    if (result > 0) sent_bytes += (size_t)result;
    return result;
}
ssize_t __wrap_recv(int fd, void *data, size_t bytes, int flags) {
    ssize_t result;
    ++recv_calls;
    if (read_mode == 1) { errno = EINTR; return -1; }
    if (read_mode == 2) { errno = EAGAIN; return -1; }
    result = __real_recv(fd, data, bytes, flags);
    if (result > 0) read_bytes += (size_t)result;
    return result;
}

static int echo_chat(const char *channel, const char *name, const char *message, int emoted, void *context) {
    assert(context == NULL);
    if (strcmp(channel, "adapter-rejected") == 0) return 0;
    send_to_discord(channel, name, message, emoted);
    return 1;
}

static void pulse(int paused) {
    send_calls = recv_calls = 0;
    sent_bytes = read_bytes = 0;
    process_discord_input();
    if (!paused) process_discord_output();
    if (send_calls > max_send_calls) max_send_calls = send_calls;
    if (recv_calls > max_recv_calls) max_recv_calls = recv_calls;
    if (sent_bytes > max_sent_bytes) max_sent_bytes = sent_bytes;
    if (read_bytes > max_read_bytes) max_read_bytes = read_bytes;
    assert(send_calls <= 32 && recv_calls <= 32);
    assert(sent_bytes <= 65536 && read_bytes <= 65536);
}

int main(int argc, char **argv) {
    struct discord_bridge_config config;
    struct discord_bridge_status status;
    struct pollfd input;
    char *line = NULL, *json;
    size_t capacity = 0;
    int paused = 0, accepted, count, i;
    cJSON *request, *response;
    const cJSON *action, *record, *channel, *name, *message, *emoted;
    memset(&config, 0, sizeof(config));
    config.max_record_bytes = argc > 1 ? strtoul(argv[1], NULL, 10) : 0;
    config.auth_token = getenv("SAMPLE_TEST_TOKEN");
    config.on_chat = argc > 2 && strcmp(argv[2], "outbound-only") == 0 ? NULL : echo_chat;
    assert(init_discord_bridge(&config));
    config.port = get_discord_bridge_status().port;
    printf("{\"port\":%u}\n", (unsigned)config.port);
    fflush(stdout);
    for (;;) {
        pulse(paused);
        input.fd = STDIN_FILENO; input.events = POLLIN; input.revents = 0;
        if (poll(&input, 1, 2) <= 0) continue;
        if (getline(&line, &capacity, stdin) < 0) break;
        request = cJSON_Parse(line);
        assert(request);
        action = cJSON_GetObjectItemCaseSensitive(request, "action");
        assert(cJSON_IsString(action));
        accepted = 0;
        if (strcmp(action->valuestring, "send") == 0 || strcmp(action->valuestring, "fill") == 0) {
            record = cJSON_GetObjectItemCaseSensitive(request, "record");
            channel = cJSON_GetObjectItemCaseSensitive(record, "channel");
            name = cJSON_GetObjectItemCaseSensitive(record, "name");
            message = cJSON_GetObjectItemCaseSensitive(record, "message");
            emoted = cJSON_GetObjectItemCaseSensitive(record, "emoted");
            assert(cJSON_IsString(channel) && cJSON_IsString(name) && cJSON_IsString(message));
            count = strcmp(action->valuestring, "fill") == 0 ? 257 : 1;
            for (i = 0; i < count; ++i)
                accepted += send_to_discord(channel->valuestring, name->valuestring, message->valuestring,
                                            cJSON_IsNumber(emoted) ? emoted->valueint : 0);
        } else if (strcmp(action->valuestring, "pause") == 0) paused = 1;
        else if (strcmp(action->valuestring, "resume") == 0) paused = 0;
        else if (strcmp(action->valuestring, "write_mode") == 0)
            write_mode = cJSON_GetObjectItemCaseSensitive(request, "value")->valueint;
        else if (strcmp(action->valuestring, "read_mode") == 0)
            read_mode = cJSON_GetObjectItemCaseSensitive(request, "value")->valueint;
        else if (strcmp(action->valuestring, "restart") == 0) assert(init_discord_bridge(&config));
        else if (strcmp(action->valuestring, "shutdown") == 0) shutdown_discord_bridge();
        else assert(strcmp(action->valuestring, "status") == 0 || strcmp(action->valuestring, "quit") == 0);
        status = get_discord_bridge_status();
        response = cJSON_CreateObject();
        cJSON_AddNumberToObject(response, "accepted", accepted);
        cJSON_AddBoolToObject(response, "connected", status.connected);
        cJSON_AddBoolToObject(response, "authenticated", status.authenticated);
        cJSON_AddBoolToObject(response, "listening", status.listening);
        cJSON_AddNumberToObject(response, "sent", status.sent);
        cJSON_AddNumberToObject(response, "received", status.received);
        cJSON_AddNumberToObject(response, "dropped", status.dropped);
        cJSON_AddNumberToObject(response, "rejected", status.rejected);
        cJSON_AddNumberToObject(response, "rejected_clients", status.rejected_clients);
        cJSON_AddNumberToObject(response, "auth_failures", status.auth_failures);
        cJSON_AddNumberToObject(response, "queued_events", status.queued_events);
        cJSON_AddNumberToObject(response, "queued_bytes", status.queued_bytes);
        cJSON_AddNumberToObject(response, "max_send_calls", max_send_calls);
        cJSON_AddNumberToObject(response, "max_recv_calls", max_recv_calls);
        cJSON_AddNumberToObject(response, "max_sent_bytes", max_sent_bytes);
        cJSON_AddNumberToObject(response, "max_read_bytes", max_read_bytes);
        json = cJSON_PrintUnformatted(response);
        assert(json);
        puts(json);
        fflush(stdout);
        cJSON_free(json);
        cJSON_Delete(response);
        if (strcmp(action->valuestring, "quit") == 0) { cJSON_Delete(request); break; }
        cJSON_Delete(request);
    }
    free(line);
    shutdown_discord_bridge();
    return 0;
}
