const { ChannelType, PermissionFlagsBits } = require("discord.js");

const MAX_RATE_LIMIT_ATTEMPTS = 5;
const definiteRejections = new Set([400, 401, 403, 404, 405, 413, 415, 422]);

async function postNewsPart(client, destination, content) {
    const channel = client.channels.cache.get(destination);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
        || !channel.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return { state: "retryable", failure: "check_destination_and_bot_permissions" };
    }

    // discord.js may replay timed-out requests or 5xx responses. Make one HTTP POST with its shared
    // bot credential. A response lost after Discord accepted the message requires reconciliation.
    const { api, version } = client.rest.options;
    try {
        const response = await fetch(api + "/v" + version + "/channels/" + destination + "/messages", {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(8000),
            headers: { Authorization: "Bot " + client.token, "Content-Type": "application/json" },
            body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
        });
        if (response.ok) {
            const message = await response.json();
            if (typeof message.id === "string" && /^[1-9]\d{16,19}$/.test(message.id)) return { id: message.id };
            return { state: "needs_review", failure: "discord_success_without_message_id" };
        }

        if (response.status === 429) {
            const header = Number(response.headers.get("retry-after"));
            const seconds = header > 0 ? header : Number((await response.json().catch(() => null))?.retry_after);
            if (header > 0) await response.body?.cancel();
            const retryAfterMs = seconds > 0 && Number.isSafeInteger(Math.ceil(seconds * 1000))
                ? Math.ceil(seconds * 1000) : 0;
            return { state: "retryable", failure: "discord_http_429", retryAfterMs };
        }
        await response.body?.cancel();
        return {
            state: definiteRejections.has(response.status) ? "retryable" : "needs_review",
            failure: "discord_http_" + response.status
        };
    } catch {
        return { state: "needs_review", failure: "discord_response_unknown" };
    }
}

async function deliverNextNews({ pool, destination, send, logger = console }) {
    const connection = await pool.getConnection();
    // Scope the advisory lock to one destination in this database. The separate committed
    // 'sending' state survives a lost lock, a connection failure, or termination after the POST.
    const lockKey = "discord-news:" + destination;
    try {
        const [{ acquired }] = await connection.query(
            "SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':', ?), 256), 0) AS acquired", [lockKey]
        );
        if (acquired !== 1) return;

        const [row] = await connection.query(
            "SELECT id, parts, message_ids, state, attempts, retry_at <= UTC_TIMESTAMP(3) AS due " +
            "FROM discord_news_delivery WHERE destination = ? AND state <> 'delivered' ORDER BY sequence_no LIMIT 1",
            [destination]
        );
        if (!row || row.state === "needs_review" || (row.state === "retryable" && !row.due)) return;
        if (row.state === "sending") {
            await connection.query(
                "UPDATE discord_news_delivery SET state = 'needs_review', failure = 'unconfirmed_previous_send', " +
                "retry_at = NULL WHERE id = ?", [row.id]
            );
            logger.error("Discord news " + row.id + " needs_review (unconfirmed_previous_send)");
            return;
        }

        const parts = JSON.parse(row.parts);
        const messages = JSON.parse(row.message_ids);
        await connection.query(
            "UPDATE discord_news_delivery SET state = 'sending', attempts = attempts + 1, retry_at = NULL WHERE id = ?",
            [row.id]
        );
        const result = await send(destination, parts[messages.length]);
        if (result.id) {
            messages.push(result.id);
            const state = messages.length === parts.length ? "delivered" : "queued";
            await connection.query(
                "UPDATE discord_news_delivery SET state = ?, message_ids = ?, attempts = 0, failure = NULL WHERE id = ?",
                [state, JSON.stringify(messages), row.id]
            );
            logger.log("Discord news " + row.id + " " + state + " (" + messages.length + "/" + parts.length + ")");
        } else {
            const attempts = row.attempts + 1;
            const delay = result.retryAfterMs !== undefined && attempts < MAX_RATE_LIMIT_ATTEMPTS
                ? Math.max(result.retryAfterMs, 1000 * 2 ** (attempts - 1)) : null;
            await connection.query(
                "UPDATE discord_news_delivery SET state = ?, failure = ?, " +
                "retry_at = TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(3)) WHERE id = ?",
                [result.state, result.failure, delay === null ? null : delay * 1000, row.id]
            );
            logger.error("Discord news " + row.id + " " + result.state + " (" + result.failure + ")");
        }
    } finally {
        // End the session if unlocking fails. Returning a session holding the lock would
        // stall the queue or let the pool hand the same lock to another worker.
        try {
            await connection.query("DO RELEASE_LOCK(SHA2(CONCAT(DATABASE(), ':', ?), 256))", [lockKey]);
            await connection.release();
        } catch {
            connection.destroy();
        }
    }
}

function startNewsWorker({ pool, destination, client, logger = console }) {
    let active;
    let outage = false;
    const timer = setInterval(() => {
        if (active || !client.isReady()) return;
        active = deliverNextNews({
            pool, destination, logger,
            send: (channel, content) => postNewsPart(client, channel, content)
        }).then(() => {
            outage = false;
        }).catch(() => {
            if (!outage) logger.error("Discord news worker could not advance; check the delivery store");
            outage = true;
        }).finally(() => {
            active = undefined;
        });
    }, 1000);
    return async () => {
        clearInterval(timer);
        await active;
    };
}

module.exports = { deliverNextNews, postNewsPart, startNewsWorker };
