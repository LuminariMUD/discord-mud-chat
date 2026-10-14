#pragma once

struct char_data;

// Call once, only after a petition/ptell command has passed its native checks.
// A target produces a reply label; no target produces a petitioner label.
void discord_petition_export(char_data *sender, const char *message, char_data *target = nullptr);
