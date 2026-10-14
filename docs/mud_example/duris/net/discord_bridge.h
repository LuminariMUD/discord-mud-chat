#ifndef DURIS_DISCORD_BRIDGE_H
#define DURIS_DISCORD_BRIDGE_H

#include <cstddef>
#include <cstdint>

// Owned exclusively by the game thread. No player session or command ingress.
struct discord_bridge_status
{
	bool listening = false;
	bool connected = false;
	bool authenticated = false;
	std::uint16_t port = 0;
	std::size_t queued_bytes = 0;
	std::size_t queued_events = 0;
	std::uint64_t sent_events = 0;
	std::uint64_t dropped_events = 0;
	std::uint64_t rejected_records = 0;
	std::uint64_t rejected_clients = 0;
	std::uint64_t auth_failures = 0;
};

// Reads DURIS_DISCORD_* environment settings. Disabled is a successful no-op.
bool discord_bridge_init();
void discord_bridge_poll();
void discord_bridge_flush();
void discord_bridge_shutdown();
discord_bridge_status discord_bridge_get_status();

// name/message must already be plain UTF-8. Serializes only channel: petition.
// False means the complete event was dropped; never saves for a later client.
bool discord_bridge_publish(const char *name, const char *message);

#endif
