# Discord bot and channel setup

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications/),
open its Bot settings and generate/reset its token. Store that token as
`DISCORD_TOKEN` in the protected runtime environment or local `.env`. Do not put
it in sample JSON, logs or a public issue. Reset a token if it has been exposed.

## Intents and installation

This application's `src/index.js` requests Guilds, Guild Messages, Message
Content and Guild Members. Enable **Message Content Intent** and **Server Members
Intent** in the application's privileged-intent settings. Presence Intent is
not used. Discord may require approval for privileged-intent access depending
on the application's verification/install status; follow its
[Gateway intent documentation](https://docs.discord.com/developers/events/gateway#gateway-intents).
These settings also apply when running the Duris one-way configuration because
the shared runtime still requests those intents.

Use the application's installation/OAuth2 URL settings to create a **guild**
installation with the `bot` scope. Request View Channel, Send Messages and Read
Message History for the selected text channels. This bridge needs no
Administrator permission or slash-command scope. Install it into the intended
server using an account authorized to manage that server.

Enable Developer Mode in your Discord client and copy the target channel's
**ID**. Put that ID in `channels[].discord`; put the arbitrary case-sensitive MUD
wire name in `channels[].mud`. Channel display names are not IDs.

## Duris staff-only audience

Create one dedicated petition text channel. Deny View Channel to `@everyone`;
allow it only for intended staff roles and the bot. Review all role and member
overrides, because another role's allow can grant access. Server owners and
Administrator roles bypass channel overwrites, so include them in the audience
review. Discord documents this in its
[permission hierarchy](https://docs.discord.com/developers/topics/permissions#permission-hierarchy).

Before rollout, test the channel with an ordinary non-staff account and the
intended staff roles, and verify the bot can view/send. Use exactly one Node
mapping with `mud: "petition"` and `direction: "mud_to_discord"`. Native Duris
independently discards incoming chat. Privacy controls the audience; direction
controls whether a post can enter the game. Discord staff must use the game
itself for authorized replies.

## Configure and verify

From the bridge repository after `npm ci`:

```sh
cp config/config.example.json config/config.json
cp .env.example .env
```

For Duris choose `config/config.duris.example.json` and follow the
[Duris guide](duris.md). Configure the dedicated MUD JSON listener, token and
channel IDs; read [deployment](deploy.md) for TLS and container namespaces.
Generic mappings omit `direction` or use `both` for both directions.

`npm start` logs into the real service. During the intended rollout, verify a
small allowed event in each selected direction; Duris must show both petition
and ptell output while an ordinary Discord post produces no game output and no
Discord-to-MUD count. Mention parsing is disabled on every outbound post.
Use one bridge process, including under [PM2 or Docker](deploy.md).

For credential-free verification, run the [test suites](testing.md). If startup
reports disallowed intents, check the two requested privileged intents above.
If the bot is connected but cannot post, check the channel ID and effective
permissions; connection health alone does not prove access or delivery.
