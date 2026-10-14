/* INTEGRATION RECIPE, not a replacement comm.c or an upstream patch.
 * Include discord_bridge.h in your game's connection owner.
 *
 * At startup, after your own configuration has opted in:
 *
 *   struct discord_bridge_config options;
 *   memset(&options, 0, sizeof(options));
 *   options.port = 8181;
 *   options.max_record_bytes = DISCORD_MAX_RECORD_BYTES;
 *   options.auth_token = getenv("MUD_AUTH_TOKEN");
 *   options.on_chat = your_chat_adapter;  // NULL for outbound-only chat
 *   options.context = NULL;
 *   if (!init_discord_bridge(&options))
 *       report_optional_bridge_failure();
 *
 * All calls belong to the game thread. In each connection/input phase call
 * process_discord_input(); in the output phase call process_discord_output().
 * They use nonblocking poll and fixed work budgets; do not add their sockets
 * to a select/FD_SET array, sleep, or call them in a busy loop.
 *
 * At ordinary shutdown call shutdown_discord_bridge(). For an exec-based
 * copyover, let close-on-exec close the sockets and call init in the new process.
 * Do not shut this endpoint down before an exec that could fail and return.
 * Test your game's actual successful and failed copyover paths after adapting.
 * Leave MUD_AUTH_TOKEN unset for local plaintext. Token/remote use requires a
 * certificate-validated TLS terminator whose backend is this loopback listener.
 */
