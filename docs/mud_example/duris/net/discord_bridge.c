#include "net/discord_bridge.h"

#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <arpa/inet.h>
#include <cjson/cJSON.h>
#include <fcntl.h>
#include <openssl/crypto.h>
#include <poll.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

namespace
{
constexpr std::size_t maximum_record_bytes = 1024 * 1024;
constexpr std::size_t maximum_queue_bytes = 4 * (maximum_record_bytes + 1);
constexpr std::size_t maximum_queue_events = 256;
constexpr std::size_t pulse_bytes = 64 * 1024;
constexpr unsigned pulse_calls = 32;
constexpr unsigned pulse_accepts = 4;
constexpr time_t authentication_timeout = 10;
constexpr time_t heartbeat_timeout = 300; // Node sends a ping every 240 seconds.

int listener = -1;
int client = -1;
time_t client_deadline = 0;
std::size_t record_limit = maximum_record_bytes;
std::string token;
std::string input;
bool discarding = false;
std::deque<std::string> output;
std::size_t output_offset = 0;
discord_bridge_status status;

time_t monotonic_seconds()
{
	timespec now{};
	clock_gettime(CLOCK_MONOTONIC, &now);
	return now.tv_sec;
}

bool would_block()
{
	if (errno == EAGAIN)
		return true;
#if EWOULDBLOCK != EAGAIN
	if (errno == EWOULDBLOCK)
		return true;
#endif
	return false;
}

void count(std::uint64_t &counter, std::size_t amount = 1)
{
	counter += std::min<std::uint64_t>(amount, UINT64_MAX - counter);
}

void disconnect_client()
{
	if (client >= 0)
		close(client);
	client = -1;
	count(status.dropped_events, output.size());
	output.clear();
	output_offset = 0;
	input.clear();
	discarding = false;
	status.connected = false;
	status.authenticated = false;
	status.queued_bytes = 0;
	status.queued_events = 0;
}

bool number_setting(const char *name, unsigned long fallback, unsigned long minimum,
		    unsigned long maximum, unsigned long &value)
{
	const char *text = getenv(name);
	value = fallback;
	if (!text || !*text)
		return true;
	if (*text < '0' || *text > '9')
		return false;
	char *end = nullptr;
	errno = 0;
	value = strtoul(text, &end, 10);
	return errno == 0 && *end == '\0' && value >= minimum && value <= maximum;
}

void consume_record()
{
	if (input.find_first_not_of(" \t\r") == std::string::npos)
		return;
	// cJSON represents strings as C strings. Reject decoded NULs rather than
	// authenticating a prefix or treating "heartbeat\u0000chat" as a control.
	bool has_nul = input.find('\0') != std::string::npos;
	for (std::size_t i = 0; i < input.size(); ++i)
		if (input[i] == '\\')
		{
			has_nul = has_nul || input.compare(i, 6, "\\u0000") == 0;
			++i;
		}
	cJSON *record = !has_nul ? cJSON_ParseWithOpts(input.c_str(), nullptr, true) : nullptr;
	const cJSON *channel = cJSON_GetObjectItemCaseSensitive(record, "channel");
	const cJSON *message = cJSON_GetObjectItemCaseSensitive(record, "message");
	const bool valid = cJSON_IsObject(record) && cJSON_IsString(channel) &&
			   cJSON_IsString(message);
	if (valid && strcmp(channel->valuestring, "auth") == 0 && !token.empty())
	{
		if (strlen(message->valuestring) == token.size() &&
		    CRYPTO_memcmp(message->valuestring, token.data(), token.size()) == 0)
		{
			status.authenticated = true;
			client_deadline = monotonic_seconds() + heartbeat_timeout;
		}
		else
		{
			count(status.auth_failures);
			disconnect_client();
		}
	}
	else if (valid && strcmp(channel->valuestring, "heartbeat") == 0 &&
		 strcmp(message->valuestring, "ping") == 0)
	{
		if (status.authenticated)
			client_deadline = monotonic_seconds() + heartbeat_timeout;
	}
	else
	{
		// Includes all incoming chat and unknown controls. There is no dispatcher.
		count(status.rejected_records);
	}
	cJSON_Delete(record);
}

void read_client()
{
	char buffer[4096];
	std::size_t remaining = pulse_bytes;
	for (unsigned calls = 0; client >= 0 && remaining && calls < pulse_calls; ++calls)
	{
		const ssize_t bytes = recv(client, buffer, std::min(sizeof(buffer), remaining), 0);
		if (bytes < 0)
		{
			if (errno == EINTR)
				continue;
			if (!would_block())
				disconnect_client();
			return;
		}
		if (bytes == 0)
		{
			disconnect_client();
			return;
		}
		remaining -= bytes;
		for (ssize_t i = 0; i < bytes && client >= 0; ++i)
		{
			if (buffer[i] == '\n')
			{
				if (!discarding)
					consume_record();
				input.clear();
				discarding = false;
			}
			else if (!discarding)
			{
				if (input.size() == record_limit)
				{
					count(status.rejected_records);
					input.clear();
					discarding = true;
				}
				else
					input.push_back(buffer[i]);
			}
		}
	}
}
} // namespace

bool discord_bridge_init()
{
	discord_bridge_shutdown();
	status = {};
	const char *enabled = getenv("DURIS_DISCORD_ENABLED");
	if (!enabled || !*enabled || !strcasecmp(enabled, "FALSE"))
		return true;
	if (strcasecmp(enabled, "TRUE"))
		return false;
	unsigned long port, limit;
	if (!number_setting("DURIS_DISCORD_PORT", 8181, 1, 65535, port) ||
	    !number_setting("DURIS_DISCORD_MAX_RECORD_BYTES", maximum_record_bytes, 128,
			    maximum_record_bytes, limit))
		return false;
	record_limit = limit;
	const char *configured_token = getenv("DURIS_DISCORD_AUTH_TOKEN");
	token = configured_token ? configured_token : "";
	// Ensure a serialized auth record can fit in the configured input budget.
	cJSON *auth = cJSON_CreateObject();
	const bool auth_fields = cJSON_AddStringToObject(auth, "channel", "auth") &&
				 cJSON_AddStringToObject(auth, "name", "bot") &&
				 cJSON_AddStringToObject(auth, "message", token.c_str());
	char *auth_json = auth_fields ? cJSON_PrintUnformatted(auth) : nullptr;
	const bool auth_fits = auth_json && strlen(auth_json) <= record_limit;
	cJSON_free(auth_json);
	cJSON_Delete(auth);
	if (!auth_fits)
		return false;

	listener = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (listener < 0)
		return false;
	int reuse = 1;
	setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
	sockaddr_in address{};
	address.sin_family = AF_INET;
	address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	address.sin_port = htons(port);
	if (bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)) < 0 ||
	    listen(listener, pulse_accepts) < 0)
	{
		discord_bridge_shutdown();
		return false;
	}
	status.listening = true;
	status.port = port;
	return true;
}

void discord_bridge_poll()
{
	if (listener < 0)
		return;
	// Check even when poll has no readable descriptors. Unauthenticated traffic
	// and incomplete/rejected records must never extend the client's deadline.
	if (client >= 0 && monotonic_seconds() >= client_deadline)
		disconnect_client();
	// poll avoids FD_SET entirely, so descriptors above FD_SETSIZE are safe.
	pollfd descriptors[] = { { listener, POLLIN, 0 }, { client, POLLIN, 0 } };
	const int ready = poll(descriptors, 2, 0);
	if (ready <= 0)
		return; // EINTR is retried on the next pulse, never in an unbounded loop.
	if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL))
	{
		discord_bridge_shutdown();
		return;
	}
	if (client >= 0)
	{
		if (descriptors[1].revents & (POLLERR | POLLNVAL))
			disconnect_client();
		else if (descriptors[1].revents & (POLLIN | POLLHUP))
			read_client();
	}
	if (!(descriptors[0].revents & POLLIN))
		return;
	for (unsigned attempt = 0; attempt < pulse_accepts; ++attempt)
	{
		const int accepted =
			accept4(listener, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
		if (accepted < 0)
		{
			if (errno == EINTR)
				continue;
			return;
		}
		if (client >= 0)
		{
			count(status.rejected_clients);
			close(accepted);
		}
		else
		{
			client = accepted;
			status.connected = true;
			status.authenticated = token.empty();
			client_deadline =
				monotonic_seconds() +
				(status.authenticated ? heartbeat_timeout : authentication_timeout);
		}
	}
}

bool discord_bridge_publish(const char *name, const char *message)
{
	if (!status.listening)
		return false; // Disabled operation is not a delivery failure.
	if (!status.authenticated || !name || !message ||
	    strnlen(name, record_limit + 1) > record_limit ||
	    strnlen(message, record_limit + 1) > record_limit ||
	    output.size() >= maximum_queue_events)
	{
		count(status.dropped_events);
		return false;
	}
	cJSON *record = cJSON_CreateObject();
	const bool fields = cJSON_AddStringToObject(record, "channel", "petition") &&
			    cJSON_AddStringToObject(record, "name", name) &&
			    cJSON_AddStringToObject(record, "message", message) &&
			    cJSON_AddNumberToObject(record, "emoted", 0);
	char *encoded = fields ? cJSON_PrintUnformatted(record) : nullptr;
	const std::size_t bytes = encoded ? strlen(encoded) : 0;
	const bool fits = encoded && bytes <= record_limit &&
			  bytes + 1 <= maximum_queue_bytes - status.queued_bytes;
	if (fits)
	{
		output.emplace_back(encoded, bytes);
		output.back().push_back('\n');
		status.queued_bytes += bytes + 1;
		status.queued_events = output.size();
	}
	else
		count(status.dropped_events);
	cJSON_free(encoded);
	cJSON_Delete(record);
	return fits;
}

void discord_bridge_flush()
{
	std::size_t remaining = pulse_bytes;
	for (unsigned calls = 0; !output.empty() && remaining && calls < pulse_calls; ++calls)
	{
		const std::string &record = output.front();
		const auto bytes = std::min(remaining, record.size() - output_offset);
		const ssize_t written =
			send(client, record.data() + output_offset, bytes, MSG_NOSIGNAL);
		if (written < 0)
		{
			if (errno == EINTR)
				continue;
			if (!would_block())
				disconnect_client();
			return;
		}
		if (written == 0)
			return;
		remaining -= written;
		output_offset += written;
		if (output_offset == record.size())
		{
			// Count the full retained allocation until the complete event drains.
			status.queued_bytes -= record.size();
			output.pop_front();
			output_offset = 0;
			status.queued_events = output.size();
			count(status.sent_events);
		}
	}
}

void discord_bridge_shutdown()
{
	disconnect_client();
	if (listener >= 0)
		close(listener);
	listener = -1;
	status.listening = false;
	status.port = 0;
	token.clear();
}

discord_bridge_status discord_bridge_get_status()
{
	return status;
}
