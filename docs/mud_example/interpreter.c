/* INTEGRATION RECIPE, not a replacement interpreter.c or an upstream patch.
 * No command-table registration is required by the transport sample.
 *
 * Implement discord_chat_callback in your own game adapter. Match only your
 * chosen wire channels, enforce game policy/rate limits/recipient toggles, and
 * render name/message as data using bounded output and literal format strings.
 * Return 1 when accepted, 0 when rejected. Strings are borrowed for this call;
 * copy them if your adapter needs them later. The callback may enqueue output
 * with send_to_discord, but must not reinitialize/shut down the transport.
 *
 * Never pass received text to command_interpreter or impersonate a privileged
 * player. An outbound-only adapter supplies NULL instead of a callback.
 * auth/heartbeat are consumed by the module and never invoke the adapter.
 *
 * An optional staff status command can display get_discord_bridge_status().
 * This sample does not install admin commands or claim configuration was saved.
 */
