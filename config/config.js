require("dotenv").config()
const fs = require("fs")
const path = require("path")

const configObj = JSON.parse( fs.readFileSync(path.join(__dirname, "config.json") ) )
configObj.discordToken = process.env.DISCORD_TOKEN
configObj.mud_auth_token = process.env.MUD_AUTH_TOKEN || configObj.mud_auth_token || ""
// Bitly removed - no longer needed
// configObj.bitlyToken = process.env.BITLY_TOKEN

module.exports = configObj
