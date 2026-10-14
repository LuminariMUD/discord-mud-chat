/* INTEGRATION RECIPE, not a replacement act.comm.c or an upstream patch.
 *
 * In the accepted branch of each explicitly selected channel command, after
 * authorization/toggle/empty checks and OUTSIDE all recipient loops, call:
 *
 *   send_to_discord(wire_channel_name, public_display_name, plain_utf8_text,
 *                   is_emote ? 1 : 0);
 *
 * Resolve wire_channel_name through your game's explicit channel mapping,
 * e.g. gossip/auction/gratz. Strip the game's own color syntax and terminal
 * controls first, preserve UTF-8, and choose the same public/hidden name policy
 * as the destination audience. This module has no game-specific color parser.
 * A zero return is a whole-event drop; keep normal game delivery unchanged.
 *
 * Do not export inside send_to_char/act/GMCP/logging/recipient loops. Do not
 * re-export your Discord adapter's output or detect its origin by username
 * substring. Keep ingress and accepted player-command export paths separate.
 * Duris uses its own module and petition/ptell hooks in duris/, not this recipe.
 */
