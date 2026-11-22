const { createHash, timingSafeEqual } = require("node:crypto");
const { createServer } = require("node:http");
const { TextDecoder } = require("node:util");
const { discordChunks, DISCORD_CONTENT_LIMIT } = require("./discord-delivery");
const { enqueueNews } = require("./news-store");

const MAX_BYTES = 64 * 1024;
const ROUTE = "/v1/announcements/news";
// JSON escaped control characters also need validation after decoding.
/* eslint-disable no-control-regex */
const decoder = new TextDecoder("utf-8", { fatal: true });

function escapeText(text) {
    return text.replace(/[\\*_~|<>[\](){}#+.!\x60]/g, "\\$&").replace(/^(\s*)-/gm, "$1\\-");
}

function renderNews({ title, body }) {
    const text = body.replace(/\r\n?/g, "\n").split(/(\bhttps?:\/\/[^\s<>"\x60]+)/giu)
        .map((part, index) => {
            if (index % 2 === 0) return escapeText(part);
            const url = part.replace(/[.,!?;:]+$/, "").replace(/\)+$/, (closing, offset, source) => {
                let unmatched = 0;
                for (const character of source.slice(0, offset)) {
                    if (character === "(") unmatched++;
                    else if (character === ")" && unmatched > 0) unmatched--;
                }
                return closing.slice(0, unmatched);
            });
            return "<" + url + ">" + escapeText(part.slice(url.length));
        }).join("");
    const parts = [];
    let pending = "**" + escapeText(title) + "**\n\n";
    for (const word of text.match(/\S+\s*|\s+/gu) || []) {
        if (pending.length + word.length > DISCORD_CONTENT_LIMIT) {
            if (pending.trim()) parts.push(pending.trimEnd());
            const chunks = [...discordChunks(word)];
            pending = chunks.pop() || "";
            parts.push(...chunks);
        } else {
            pending += word;
        }
    }
    if (pending.trim()) parts.push(pending.trimEnd());
    return parts;
}

function digest(value) {
    return createHash("sha256").update(value).digest();
}

function reply(response, status, data) {
    response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Connection": "close"
    });
    response.end(JSON.stringify(data));
}

async function readAnnouncement(request) {
    if (Number(request.headers["content-length"]) > MAX_BYTES) return { status: 413, error: "request_too_large" };
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return { status: 413, error: "request_too_large" };
        chunks.push(chunk);
    }

    let data;
    try {
        data = JSON.parse(decoder.decode(Buffer.concat(chunks)));
    } catch {
        return { status: 400, error: "invalid_utf8_json" };
    }
    if (!data || Object.keys(data).length !== 3 ||
        typeof data.id !== "string" || !/^[a-f0-9]{64}$/.test(data.id) ||
        typeof data.title !== "string" || !data.title.trim() || data.title.length > 200 ||
        /[\x00-\x1f\x7f]/.test(data.title) || !data.title.isWellFormed() ||
        typeof data.body !== "string" || !data.body.trim() || !data.body.isWellFormed() ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.body)) {
        return { status: 400, error: "expected_id_title_body" };
    }
    return { data };
}

function createNewsIntake({ config, pool, logger = console }) {
    const expected = digest("Bearer " + config.secret);
    const server = createServer({
        headersTimeout: 5000,
        requestTimeout: 5000,
        connectionsCheckingInterval: 1000,
        maxHeaderSize: 4096
    }, async (request, response) => {
        try {
            if (request.url !== ROUTE || request.method !== "POST") {
                return reply(response, 404, { error: "not_found" });
            }
            if (!timingSafeEqual(expected, digest(request.headers.authorization || ""))) {
                return reply(response, 401, { error: "unauthorized" });
            }
            if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
                return reply(response, 415, { error: "expected_application_json" });
            }
            const { data, status, error } = await readAnnouncement(request);
            if (!data) return reply(response, status, { error });

            let result;
            try {
                result = await enqueueNews(pool, data, config.channelId, renderNews(data));
            } catch {
                logger.error("Discord news " + data.id + " intake failed: delivery store unavailable");
                return reply(response, 503, { error: "delivery_store_unavailable" });
            }
            if (result.conflict) return reply(response, 409, { error: "id_conflict" });
            if (result.created) logger.log("Discord news " + data.id + " queued");
            return reply(response, result.created ? 202 : 200, { id: data.id, state: result.state });
        } catch {
            if (!response.destroyed) reply(response, 400, { error: "incomplete_request" });
        }
    });
    server.maxConnections = 32;
    return {
        start: () => new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(config.port, config.host, () => {
                server.off("error", reject);
                resolve(server.address());
            });
        }),
        stop: () => new Promise(resolve => server.close(() => resolve()))
    };
}

module.exports = { createNewsIntake, renderNews };
