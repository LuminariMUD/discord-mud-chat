if (discord_bridge->outbuf_len > 0)
FD_SET(discord_bridge->client_socket, &output_set);
if (discord_bridge->client_socket > maxdesc)
maxdesc = discord_bridge->client_socket;
}
}

for (d = descriptor_list; d; d = d->next)
{
#ifndef CIRCLE_WINDOWS


@@ -1057,6 +1083,27 @@ void game_loop(socket_t local_mother_desc)
/* If there are new connections waiting, accept them. */
if (FD_ISSET(local_mother_desc, &input_set))
new_descriptor(local_mother_desc);

/* Process Discord bridge */
if (discord_bridge) {
/* Check for new Discord bridge connections */
if (discord_bridge->server_socket != INVALID_SOCKET && 
FD_ISSET(discord_bridge->server_socket, &input_set)) {
accept_discord_connection();
}

/* Process Discord bridge input */
if (discord_bridge->client_socket != INVALID_SOCKET &&
FD_ISSET(discord_bridge->client_socket, &input_set)) {
process_discord_input();
}

/* Process Discord bridge output */
if (discord_bridge->client_socket != INVALID_SOCKET &&
FD_ISSET(discord_bridge->client_socket, &output_set)) {
process_discord_output();
}
}

/* Kick out the freaky folks in the exception set and marked for close */
for (d = descriptor_list; d; d = next_d)