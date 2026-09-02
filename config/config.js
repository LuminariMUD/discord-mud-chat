require("dotenv").config();
const path = require("path");
const { loadConfig } = require("./load-config");

module.exports = loadConfig({
    configPath: path.join(__dirname, "config.json")
});
