const { createNewsPool } = require("./news-store");
const { createNewsIntake } = require("./news-intake");
const { startNewsWorker } = require("./news-worker");

function createNewsService(config, client) {
    const pool = createNewsPool(config.database);
    const intake = config.enabled && createNewsIntake({ config, pool });
    let starting;
    let stopWorker;

    return {
        start() {
            starting = (async () => {
                const address = intake ? await intake.start() : undefined;
                if (config.send) stopWorker = startNewsWorker({ pool, destination: config.channelId, client });
                return address;
            })();
            return starting;
        },
        async stop() {
            await starting?.catch(() => {});
            await Promise.all([intake && intake.stop(), stopWorker?.()]);
            await pool.end();
        }
    };
}

module.exports = { createNewsService };
