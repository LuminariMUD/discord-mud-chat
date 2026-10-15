#include "net/discord_petition.h"
#include "net/discord_bridge.h"
#include "net/ansi.h"
#include "net/unicode.h"
#include "core/structs.h"
#include "core/utils.h"
#include "core/prototypes.h"

#include <cstring>
#include <string>

namespace
{
	bool plain_text(const char *source, std::size_t capacity, std::string &result)
	{
		// Bound by the actual native name/message buffers before parsing. Refuse
		// an overlong value as a whole rather than exporting a truncated event.
		if (!source || strnlen(source, capacity) == capacity)
			return false;
		enum class escape_state
		{
			text,
			escape,
			intermediate,
			csi,
			string,
			string_escape
		};
		auto state = escape_state::text;
		for (wchar_t colored : AnsiString(source))
		{
			const auto c = GET_CHAR(colored);
			if (state == escape_state::string || state == escape_state::string_escape)
			{
				if (c == 7 || c == 0x9c || c == 0x18 || c == 0x1a ||
				    (state == escape_state::string_escape && c == '\\'))
					state = escape_state::text;
				else
					state = c == 0x1b ? escape_state::string_escape :
							    escape_state::string;
				continue;
			}
			if (c == 0x1b)
			{
				state = escape_state::escape;
				continue;
			}
			if (c == 0x9b)
			{
				state = escape_state::csi;
				continue;
			}
			if (c == 0x90 || c == 0x98 || c == 0x9d || c == 0x9e || c == 0x9f)
			{
				state = escape_state::string;
				continue;
			}
			if (state == escape_state::escape)
			{
				if (c == '[')
					state = escape_state::csi;
				else if (c == ']' || c == 'P' || c == 'X' || c == '^' || c == '_')
					state = escape_state::string;
				else if (c >= 0x20 && c <= 0x2f)
					state = escape_state::intermediate;
				else
					state = escape_state::text;
				continue;
			}
			if (state == escape_state::csi || state == escape_state::intermediate)
			{
				const auto final_min = state == escape_state::csi ? 0x40 : 0x30;
				if ((c >= final_min && c <= 0x7e) || c == 0x18 || c == 0x1a)
					state = escape_state::text;
				continue;
			}
			if ((c < 0x20 && c != '\n' && c != '\t') || (c >= 0x7f && c <= 0x9f))
				continue;
			char encoded[4];
			char *end = encoded;
			put_utf8(end, c);
			result.append(encoded, end);
		}
		return true;
	}
} // namespace

void discord_petition_export(char_data *sender, const char *message, char_data *target)
{
	const auto status = discord_bridge_get_status();
	if (!status.listening)
		return;
	std::string name, text, target_name;
	// This is a staff audit feed: game concealment must not remove either identity.
	if (!status.authenticated || !plain_text(GET_NAME(sender), MAX_NAME_LENGTH + 1, name) ||
	    !plain_text(message, MAX_STRING_LENGTH, text) ||
	    (target && !plain_text(GET_NAME(target), MAX_NAME_LENGTH + 1, target_name)))
	{
		discord_bridge_publish(nullptr, nullptr); // account for the whole dropped event
		return;
	}
	if (target)
		name += " -> " + target_name;
	// process_line doubles literal dollars before command dispatch. Match the
	// native output boundary without changing the command's input or recipients.
	delete_doubledollar(text.data());
	text.resize(std::strlen(text.c_str()));
	discord_bridge_publish(name.c_str(), text.c_str());
}
