/* Copyright (C) 2025 LuminariMUD. See the repository license.
 * Generic Linux/POSIX C89 sample; requires cJSON. See README.md. */
#define _POSIX_C_SOURCE 200809L
#include "discord_bridge.h"
#include <cjson/cJSON.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <float.h>
#include <limits.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define PULSE_BYTES (64UL * 1024UL)
#define PULSE_CALLS 32
#define AUTHENTICATION_TIMEOUT 10
#define HEARTBEAT_TIMEOUT 300 /* Node sends a ping every 240 seconds. */

struct output_record {
    char *wire;
    size_t bytes, offset;
    struct output_record *next;
};
static int listener = -1, client = -1;
static time_t client_deadline = 0;
static char *input = NULL, *token = NULL;
static size_t used = 0, record_limit = DISCORD_MAX_RECORD_BYTES;
static int discarding = 0;
static struct output_record *front = NULL, *back = NULL;
static struct discord_bridge_status status;
static discord_chat_callback on_chat = NULL;
static void *chat_context = NULL;

static time_t monotonic_seconds(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec;
}

static void increment(unsigned long *value) {
    if (*value < ULONG_MAX) ++*value;
}

static int would_block(void) {
    return errno == EAGAIN || errno == EWOULDBLOCK;
}

static int configure_socket(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    int descriptor_flags = fcntl(fd, F_GETFD, 0);
    return flags >= 0 && descriptor_flags >= 0 &&
        fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 &&
        fcntl(fd, F_SETFD, descriptor_flags | FD_CLOEXEC) == 0;
}

static void disconnect_client(void) {
    struct output_record *next;
    if (client >= 0) close(client);
    client = -1;
    while (front) {
        next = front->next;
        free(front->wire);
        free(front);
        front = next;
        increment(&status.dropped);
    }
    back = NULL;
    used = 0;
    discarding = 0;
    status.connected = status.authenticated = 0;
    status.queued_bytes = status.queued_events = 0;
}

void shutdown_discord_bridge(void) {
    disconnect_client();
    if (listener >= 0) close(listener);
    listener = -1;
    free(input);
    free(token);
    input = token = NULL;
    on_chat = NULL;
    chat_context = NULL;
    status.listening = 0;
    status.port = 0;
}

/* Bound caller strings before allocating JSON; a record cannot be smaller than
 * the sum of its unescaped string bytes. cJSON handles all escaping afterward. */
static int strings_fit(const char *channel, const char *name, const char *message) {
    const char *fields[3];
    size_t total = 0, i, j;
    fields[0] = channel; fields[1] = name; fields[2] = message;
    for (i = 0; i < 3; ++i) {
        if (!fields[i]) return 0;
        for (j = 0; fields[i][j]; ++j) {
            if (total == record_limit) return 0;
            ++total;
        }
    }
    return 1;
}

static char *serialize(const char *channel, const char *name, const char *message, int emoted) {
    cJSON *record;
    char *json = NULL;
    if (!strings_fit(channel, name, message)) return NULL;
    record = cJSON_CreateObject();
    if (record && cJSON_AddStringToObject(record, "channel", channel) &&
        cJSON_AddStringToObject(record, "name", name) &&
        cJSON_AddStringToObject(record, "message", message) &&
        cJSON_AddNumberToObject(record, "emoted", emoted))
        json = cJSON_PrintUnformatted(record);
    cJSON_Delete(record);
    return json;
}

int init_discord_bridge(const struct discord_bridge_config *config) {
    struct sockaddr_in address;
    socklen_t length = sizeof(address);
    int reuse = 1;
    char *auth;
    const char *configured_token;
    shutdown_discord_bridge();
    memset(&status, 0, sizeof(status));
    if (!config) return 0;
    record_limit = config->max_record_bytes ? config->max_record_bytes : DISCORD_MAX_RECORD_BYTES;
    if (record_limit < 128 || record_limit > DISCORD_MAX_RECORD_BYTES) return 0;
    configured_token = config->auth_token ? config->auth_token : "";
    auth = serialize("auth", "bot", configured_token, 0);
    if (!auth) return 0;
    if (strlen(auth) > record_limit) {
        cJSON_free(auth);
        return 0;
    }
    cJSON_free(auth);
    input = (char *)malloc(record_limit + 1);
    token = (char *)malloc(strlen(configured_token) + 1);
    if (!input || !token) goto failure;
    strcpy(token, configured_token);
    listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0 || !configure_socket(listener)) goto failure;
    if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) goto failure;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(config->port);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0 ||
        listen(listener, 4) < 0 || getsockname(listener, (struct sockaddr *)&address, &length) < 0)
        goto failure;
    on_chat = config->on_chat;
    chat_context = config->context;
    status.port = ntohs(address.sin_port);
    status.listening = 1;
    return 1;
failure:
    shutdown_discord_bridge();
    return 0;
}

static int token_matches(const char *candidate) {
    size_t length = strlen(token), i;
    unsigned char difference = 0;
    if (strlen(candidate) != length) return 0;
    for (i = 0; i < length; ++i)
        difference |= (unsigned char)candidate[i] ^ (unsigned char)token[i];
    return difference == 0;
}

/* cJSON decodes escapes but does not validate literal UTF-8 in JSON strings. */
static int valid_utf8(const char *text) {
    const unsigned char *p = (const unsigned char *)text;
    unsigned long codepoint, minimum;
    unsigned int remaining;
    while (*p) {
        if (*p < 0x80) { ++p; continue; }
        if (*p >= 0xc2 && *p <= 0xdf) {
            codepoint = *p & 0x1f; minimum = 0x80; remaining = 1;
        } else if (*p >= 0xe0 && *p <= 0xef) {
            codepoint = *p & 0x0f; minimum = 0x800; remaining = 2;
        } else if (*p >= 0xf0 && *p <= 0xf4) {
            codepoint = *p & 0x07; minimum = 0x10000; remaining = 3;
        } else return 0;
        ++p;
        while (remaining--) {
            if (*p < 0x80 || *p > 0xbf) return 0;
            codepoint = (codepoint << 6) | (*p++ & 0x3f);
        }
        if (codepoint < minimum || codepoint > 0x10ffff ||
            (codepoint >= 0xd800 && codepoint <= 0xdfff)) return 0;
    }
    return 1;
}

static void consume_record(void) {
    cJSON *record;
    const cJSON *channel, *name, *message, *emoted;
    size_t i;
    int has_nul = memchr(input, '\0', used) != NULL;
    input[used] = '\0';
    /* cJSON stores C strings. Reject decoded NULs instead of matching a prefix.
     * Skip escaped backslashes so literal text "\\u0000" remains valid. */
    for (i = 0; i < used; ++i) {
        if (input[i] == '\\') {
            if (used - i >= 6 && memcmp(input + i, "\\u0000", 6) == 0) has_nul = 1;
            ++i;
        }
    }
    if (!has_nul && strspn(input, " \t\r") == used) return;
    record = has_nul ? NULL : cJSON_ParseWithOpts(input, NULL, 1);
    channel = cJSON_GetObjectItemCaseSensitive(record, "channel");
    name = cJSON_GetObjectItemCaseSensitive(record, "name");
    message = cJSON_GetObjectItemCaseSensitive(record, "message");
    emoted = cJSON_GetObjectItemCaseSensitive(record, "emoted");
    if (!cJSON_IsObject(record) || !cJSON_IsString(channel) || !cJSON_IsString(message) ||
        !valid_utf8(channel->valuestring) || !valid_utf8(message->valuestring)) {
        increment(&status.rejected);
    } else if (strcmp(channel->valuestring, "auth") == 0) {
        if (!*token || token_matches(message->valuestring)) {
            status.authenticated = 1;
            client_deadline = monotonic_seconds() + HEARTBEAT_TIMEOUT;
        }
        else {
            increment(&status.auth_failures);
            disconnect_client();
        }
    } else if (strcmp(channel->valuestring, "heartbeat") == 0) {
        if (strcmp(message->valuestring, "ping") != 0) increment(&status.rejected);
        else if (status.authenticated) client_deadline = monotonic_seconds() + HEARTBEAT_TIMEOUT;
    } else if (!status.authenticated || !cJSON_IsString(name) || !valid_utf8(name->valuestring) ||
               (emoted && (!cJSON_IsNumber(emoted) ||
                emoted->valuedouble > DBL_MAX || emoted->valuedouble < -DBL_MAX)) || !on_chat) {
        increment(&status.rejected);
    } else if (on_chat(channel->valuestring, name->valuestring, message->valuestring,
                       emoted && emoted->valuedouble == 1, chat_context)) {
        increment(&status.received);
    } else increment(&status.rejected);
    cJSON_Delete(record);
}

void process_discord_input(void) {
    struct pollfd descriptors[2];
    char buffer[4096];
    size_t remaining = PULSE_BYTES, amount, i;
    ssize_t bytes;
    int ready, attempts, accepted;
    if (listener < 0) return;
    /* Run before poll: silence and partial/rejected input cannot renew a lease. */
    if (client >= 0 && monotonic_seconds() >= client_deadline) disconnect_client();
    descriptors[0].fd = listener; descriptors[0].events = POLLIN; descriptors[0].revents = 0;
    descriptors[1].fd = client; descriptors[1].events = POLLIN; descriptors[1].revents = 0;
    ready = poll(descriptors, 2, 0);
    if (ready <= 0) return;
    if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) {
        shutdown_discord_bridge();
        return;
    }
    if (client >= 0 && (descriptors[1].revents & (POLLERR | POLLNVAL))) disconnect_client();
    if (client >= 0 && (descriptors[1].revents & (POLLIN | POLLHUP))) {
        for (attempts = 0; client >= 0 && remaining && attempts < PULSE_CALLS; ++attempts) {
            amount = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
            bytes = recv(client, buffer, amount, 0);
            if (bytes < 0) {
                if (errno == EINTR) continue;
                if (!would_block()) disconnect_client();
                break;
            }
            if (bytes == 0) { disconnect_client(); break; }
            remaining -= (size_t)bytes;
            for (i = 0; i < (size_t)bytes && client >= 0; ++i) {
                if (buffer[i] == '\n') {
                    if (!discarding) consume_record();
                    used = 0; discarding = 0;
                } else if (!discarding) {
                    if (used == record_limit) {
                        increment(&status.rejected);
                        used = 0; discarding = 1;
                    } else input[used++] = buffer[i];
                }
            }
        }
    }
    if (!(descriptors[0].revents & POLLIN)) return;
    for (attempts = 0; attempts < 4; ++attempts) {
        accepted = accept(listener, NULL, NULL);
        if (accepted < 0) {
            if (errno == EINTR) continue;
            return;
        }
        if (client >= 0 || !configure_socket(accepted)) {
            increment(&status.rejected_clients);
            close(accepted);
        } else {
            client = accepted;
            status.connected = 1;
            status.authenticated = !*token;
            client_deadline = monotonic_seconds() +
                (status.authenticated ? HEARTBEAT_TIMEOUT : AUTHENTICATION_TIMEOUT);
        }
    }
}

int send_to_discord(const char *channel, const char *name, const char *message, int emoted) {
    char *json;
    size_t bytes;
    struct output_record *event;
    if (!status.listening) return 0;
    if (!status.authenticated || status.queued_events == DISCORD_MAX_QUEUED_EVENTS ||
        status.queued_bytes == DISCORD_MAX_QUEUED_BYTES) goto dropped;
    json = serialize(channel, name, message, emoted);
    if (!json) goto dropped;
    bytes = strlen(json);
    if (bytes > record_limit || bytes + 1 > DISCORD_MAX_QUEUED_BYTES - status.queued_bytes) {
        cJSON_free(json);
        goto dropped;
    }
    event = (struct output_record *)calloc(1, sizeof(*event));
    if (!event) { cJSON_free(json); goto dropped; }
    event->wire = (char *)malloc(bytes + 1);
    if (!event->wire) { free(event); cJSON_free(json); goto dropped; }
    memcpy(event->wire, json, bytes);
    event->wire[bytes] = '\n';
    event->bytes = bytes + 1;
    cJSON_free(json);
    if (back) back->next = event;
    else front = event;
    back = event;
    status.queued_bytes += event->bytes;
    ++status.queued_events;
    return 1;
dropped:
    increment(&status.dropped);
    return 0;
}

void process_discord_output(void) {
    size_t remaining = PULSE_BYTES, amount;
    ssize_t bytes;
    int attempts;
    struct output_record *done;
    for (attempts = 0; client >= 0 && front && remaining && attempts < PULSE_CALLS; ++attempts) {
        amount = front->bytes - front->offset;
        if (amount > remaining) amount = remaining;
        bytes = send(client, front->wire + front->offset, amount, MSG_NOSIGNAL);
        if (bytes < 0) {
            if (errno == EINTR) continue;
            if (!would_block()) disconnect_client();
            return;
        }
        if (bytes == 0) { disconnect_client(); return; }
        remaining -= (size_t)bytes;
        front->offset += (size_t)bytes;
        if (front->offset == front->bytes) {
            done = front;
            front = front->next;
            if (!front) back = NULL;
            status.queued_bytes -= done->bytes;
            --status.queued_events;
            increment(&status.sent);
            free(done->wire);
            free(done);
        }
    }
}

struct discord_bridge_status get_discord_bridge_status(void) { return status; }
