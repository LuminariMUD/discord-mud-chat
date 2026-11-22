# Duris Discord news

Verified player news uses an outbound-only destination separate from the chat
and staff petition mappings. The intake is off unless explicitly enabled. Run
the bridge and Duris on the same host or in the same network namespace.

## Set up the intake

1. Create a dedicated MariaDB database using InnoDB and apply
   `config/news-delivery.sql` to it as a schema owner. Grant the bridge account
   `SELECT`, `INSERT`, and `UPDATE` on `discord_news_delivery` in that database.
2. Give the bot View Channel and Send Messages in the public Discord text or
   announcement channel. Use a channel ID that does not appear in `channels`.
3. Set the bridge's `DISCORD_NEWS_INGEST_SECRET` and
   `DISCORD_NEWS_DB_PASSWORD` in its environment. Generate the ingest secret
   with `openssl rand -hex 32` and share it only with the Duris publisher.
4. Add a `news` object to `config/config.json` and restart the bridge.

```json
{
    "news": {
        "enabled": true,
        "host": "127.0.0.1",
        "port": 3181,
        "channel_id": "123456789012345678",
        "database": {
            "host": "127.0.0.1",
            "port": 3306,
            "name": "discord_news",
            "user": "discord_news"
        }
    }
}
```

The listener accepts the literal loopback addresses `127.0.0.1` and `::1`.
The defaults are `127.0.0.1:3181` and MariaDB at `127.0.0.1:3306`. For a
local MariaDB Unix socket, set `database.socket_path` instead of its host and
port. For containers, use a shared network namespace so both services can access
loopback. Do not publish the intake port.

## Publisher contract

Send `POST /v1/announcements/news` with `Authorization: Bearer <secret>`,
`Content-Type: application/json`, and exactly three string fields:

- `id` is the lowercase SHA-256 of the verified LF-normalized source section.
- `title` is a single line up to 200 UTF-16 units.
- `body` is nonempty plain text, with paragraphs and lists separated by newlines.

The entire JSON request is limited to 64 KiB, with a five-second receive timeout.
Use a bounded publisher timeout and retry with the exact same payload after
an outage or timeout. A new durable record returns `202` with `id` and `state`.
A duplicate returns `200` with the current state. Reusing an ID with different
content returns `409`. A `503` indicates the delivery store was unavailable.
Acceptance and Discord delivery are reported separately.

Set `news.enabled` to `false` and restart to disable the intake. Keep the database
so a restarted bridge can still recognize previously accepted IDs.
