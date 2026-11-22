const { createNewsPool } = require("./news-store");
const { createNewsIntake } = require("./news-intake");

function createNewsService(config) {
    const pool = createNewsPool(config.database);
    const intake = createNewsIntake({ config, pool });
    let starting;

    return {
        start() {
            starting = intake.start();
            return starting;
        },
        async stop() {
            await starting?.catch(() => {});
            await intake.stop();
            await pool.end();
        }
    };
}

module.exports = { createNewsService };
