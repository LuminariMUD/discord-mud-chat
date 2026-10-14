// Independent generic peer: no bridge imports, Duris files or Discord credentials.
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");

const sockets = [];
let server;
process.on("message", async ({ id, command, ...args }) => {
    try {
        let result;
        if (command === "listen") {
            const connected = socket => {
                const index = sockets.push(socket) - 1;
                const decoder = new StringDecoder("utf8");
                let pending = "";
                if (args.paused) socket.pause();
                socket.on("error", () => {});
                socket.on("data", bytes => {
                    pending += decoder.write(bytes);
                    let delimiter;
                    while ((delimiter = pending.indexOf("\n")) !== -1) {
                        const record = pending.slice(0, delimiter);
                        pending = pending.slice(delimiter + 1);
                        process.send({ event: "record", index, length: Buffer.byteLength(record),
                            record: record.length < 2048 ? record : undefined });
                    }
                });
                socket.on("close", () => process.send({ event: "closed", index }));
                process.send({ event: "connected", index });
            };
            server = args.tls
                ? tls.createServer({ key: fs.readFileSync(args.key), cert: fs.readFileSync(args.cert) }, connected)
                : net.createServer(connected);
            server.on("tlsClientError", error => process.send({ event: "tlsError", code: error.code }));
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            result = server.address().port;
        } else {
            const socket = sockets[args.index || 0];
            if (command === "send") {
                const bytes = Buffer.from(args.text, "utf8");
                const size = args.fragment || bytes.length;
                for (let offset = 0; offset < bytes.length; offset += size) {
                    socket.write(bytes.subarray(offset, offset + size));
                    if (args.fragment) await new Promise(resolve => setImmediate(resolve));
                }
            } else if (command === "close") socket.destroy();
            else if (command === "resume") socket.resume();
            else throw new Error("Unknown peer command");
        }
        process.send({ id, result });
    } catch (error) {
        process.send({ id, error: error.message });
    }
});
process.on("disconnect", () => {
    for (const socket of sockets) socket.destroy();
    if (server) server.close();
});
