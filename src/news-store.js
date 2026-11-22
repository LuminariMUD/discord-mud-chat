const mariadb = require("mariadb");

function createNewsPool(database) {
    return mariadb.createPool({
        ...database,
        connectionLimit: 4,
        acquireTimeout: 2000,
        connectTimeout: 1500,
        queryTimeout: 2000,
        socketTimeout: 3000,
        // Parse JSON explicitly for consistent behavior across MariaDB versions.
        autoJsonMap: false
    });
}

async function enqueueNews(pool, { id, title, body }, destination, parts) {
    // An autocommitted insert owns the unique ID. A duplicate leaves the stored payload and destination intact.
    let created = true;
    try {
        await pool.query(
            "INSERT INTO discord_news_delivery (id, destination, title, body, parts) VALUES (?, ?, ?, ?, ?)",
            [id, destination, title, body, JSON.stringify(parts)]
        );
    } catch (error) {
        if (error.code !== "ER_DUP_ENTRY") throw error;
        created = false;
    }
    const [row] = await pool.query("SELECT title, body, state FROM discord_news_delivery WHERE id = ?", [id]);
    if (row.title !== title || row.body !== body) return { conflict: true };
    return { created, state: row.state === "sending" ? "queued" : row.state };
}

module.exports = { createNewsPool, enqueueNews };
