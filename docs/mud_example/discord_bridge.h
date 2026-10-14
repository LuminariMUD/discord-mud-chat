/* Copyright (C) 2025 LuminariMUD. See the repository license.
 * Generic Linux/POSIX C89 sample. This is not the native Duris module. */
#ifndef SAMPLE_DISCORD_BRIDGE_H
#define SAMPLE_DISCORD_BRIDGE_H

#include <stddef.h>

#define DISCORD_MAX_RECORD_BYTES (1024UL * 1024UL)
#define DISCORD_MAX_QUEUED_BYTES (4UL * (DISCORD_MAX_RECORD_BYTES + 1UL))
#define DISCORD_MAX_QUEUED_EVENTS 256UL

/* Called on the game thread with borrowed strings valid until return.
 * Return nonzero only if your adapter accepts the channel/message.
 * Display as data; never send these strings to a command interpreter.
 * The callback may enqueue output but must not reinitialize, shut down, or
 * recursively process the transport before returning.
 * A NULL callback disables incoming chat, while still consuming controls. */
typedef int (*discord_chat_callback)(const char *channel, const char *name,
                                    const char *message, int emoted, void *context);

struct discord_bridge_config {
    unsigned short port;       /* 8181 normally; 0 selects an ephemeral test port. */
    size_t max_record_bytes;    /* 0 defaults to 1 MiB; otherwise 128..1 MiB. */
    const char *auth_token;     /* Copied at init; NULL/empty disables auth. */
    discord_chat_callback on_chat;
    void *context;
};

struct discord_bridge_status {
    int listening, connected, authenticated;
    unsigned short port;
    size_t queued_bytes, queued_events;
    unsigned long sent, received, dropped, rejected, rejected_clients, auth_failures;
};

/* Own all calls on one game thread. Returns 0 on invalid settings/bind/allocation
 * failure and leaves this optional endpoint closed. No socket is opened before
 * init. Binds only 127.0.0.1; remote/token use requires a TLS terminator. */
int init_discord_bridge(const struct discord_bridge_config *config);
void shutdown_discord_bridge(void);
void process_discord_input(void);  /* Connection phase: nonblocking, fixed budget. */
void process_discord_output(void); /* Output phase: nonblocking, fixed budget. */
struct discord_bridge_status get_discord_bridge_status(void);

/* Caller supplies plain UTF-8 (strip game colors/controls at its own boundary).
 * Returns 1 for whole-event admission; 0 for a whole-event drop. No truncation,
 * implicit channel allowlist, or replay. Sent counts socket completion, not
 * Discord receipt. Normal messages use 0, emotes use 1. */
int send_to_discord(const char *channel, const char *name, const char *message, int emoted);

#endif
