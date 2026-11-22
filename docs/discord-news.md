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

## Delivery, retry and reconciliation

The sender uses the existing bot and sends parts in stored order. The database
records each confirmed Discord message ID. A rate limit uses Discord's retry
delay and increasing backoff for up to five attempts per part. Other explicit
rejections pause the row for an operator. An unresolved row holds later
announcements for its destination.

Look up state without displaying announcement text or credentials.

```sql
SET @id = '<announcement SHA-256>';
SELECT id, destination, state, JSON_LENGTH(parts) AS parts,
       message_ids, attempts, retry_at, failure
FROM discord_news_delivery WHERE id = @id;
```

- `queued` means waiting or partly delivered. `sending` means a worker claimed a part.
- `delivered` means all parts have confirmed Discord message IDs.
- `retryable` with a scheduled `retry_at` means an automatic retry is pending.
  With no `retry_at`, correct the logged failure before resuming.
- `needs_review` means the last request may have reached Discord. The worker
  waits for reconciliation.

To resume a definite failure, correct its cause and run the following update.
It preserves all confirmed message IDs.

```sql
UPDATE discord_news_delivery
SET state = 'queued', attempts = 0, retry_at = NULL, failure = NULL
WHERE id = @id AND state = 'retryable' AND retry_at IS NULL;
```

For `needs_review`, pause every sender for this database and destination. Find
the first unconfirmed part at index `JSON_LENGTH(message_ids)` in `parts`. Check
the Discord channel and bot author, using existing message IDs and the incident
time as anchors. If you confirm it was posted, record its Discord message ID.

```sql
SET @discord_message_id = '<confirmed Discord message ID>';
UPDATE discord_news_delivery
SET state = IF(JSON_LENGTH(message_ids) + 1 = JSON_LENGTH(parts), 'delivered', 'queued'),
    message_ids = JSON_ARRAY_APPEND(message_ids, '$', @discord_message_id),
    attempts = 0, retry_at = NULL, failure = NULL
WHERE id = @id AND state = 'needs_review';
```

If you confirm the message was never posted, reset the `needs_review` row to
`queued` with `attempts = 0, retry_at = NULL, failure = NULL`, leaving
`message_ids` intact. Leave it in `needs_review` if the result is still
uncertain. Resume the senders after reconciliation.

## Pause or roll back

Set `news.send` to `false` and restart each bridge worker to pause delivery.
Set `news.enabled` to `false` to close intake. If you omit `news.send`, it
follows `news.enabled`. Set `news.send` explicitly to `true` to drain existing
records with intake disabled. For rollback, disable both settings and retain
the database when reverting the bridge. Rows keep their original destination.
Drain or reconcile that destination before changing the configured channel.

Deploy the bridge with intake and delivery enabled in staging before opting
Duris in. Confirm the bot can post to the intended channel and that a verified
test update goes from accepted to delivered. During rollback, turn Duris
submission off before closing bridge intake.

Run `bash scripts/test-news-mariadb.sh npm run test:coverage` on a host with the
MariaDB server tools to exercise the worker and intake against an isolated
database. The tests also use an isolated HTTP sink for Discord.
