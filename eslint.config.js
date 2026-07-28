const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    {
        ignores: [
            "config/config.json",
            "logs/"
        ]
    },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: globals.node
        },
        rules: {
            "no-console": "off",
            "no-unused-vars": "error",
            "semi": ["error", "always"]
        }
    }
];
