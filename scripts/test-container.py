#!/usr/bin/env python3
"""Build the real image and check Linux host-loopback topology without Discord."""
import json
import os
from pathlib import Path
import socket
import subprocess
import threading

ROOT = Path(__file__).resolve().parent.parent
# The fixture runs here; a remote daemon would make host-loopback evidence invalid.
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]
env = dict(os.environ)
for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
    env.pop(key, None)
subprocess.run([*DOCKER, "info", "--format", "{{.ServerVersion}}"], env=env, check=True)
image = f"mud-discord-chat:integration-{os.getpid()}"
build = [*DOCKER, "build", "-t", image]
if os.environ.get("CODEX_PROXY_CERT"):
    build += ["--secret", f"id=proxy_ca,src={os.environ['CODEX_PROXY_CERT']}"]
build += ["."]
subprocess.run(build, cwd=ROOT, env=env, check=True)
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(20)
    captured = []
    errors = []

    def peer():
        try:
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(15)
                record = dict(channel="petition", name="Fixture", message="Network namespace 你好 🔥", emoted=0)
                connection.sendall((json.dumps(record, ensure_ascii=False) + "\n").encode())
                while data := connection.recv(4096):
                    captured.append(data)
        except Exception as error:
            errors.append(error)

    thread = threading.Thread(target=peer, daemon=True)
    thread.start()
    name = f"mud-bridge-smoke-{os.getpid()}"
    command = [*DOCKER, "run", "--rm", "--name", name, "--network", "host",
               "--mount", f"type=bind,src={ROOT / 'scripts/testing/deployment-smoke.js'},dst=/smoke.js,readonly",
               "-e", "BRIDGE_MODULE_ROOT=/app", "-e", "HEALTH_PORT=0",
               "-e", f"SMOKE_MUD_PORT={listener.getsockname()[1]}",
               image, "node", "/smoke.js"]
    try:
        subprocess.run(command, cwd=ROOT, env=env, check=True, timeout=30)
        thread.join(timeout=5)
        assert not thread.is_alive(), "container did not close its MUD connection"
        assert not errors, errors
        assert captured == [], "one-way Discord post wrote chat into the fixture"
    finally:
        subprocess.run([*DOCKER, "rm", "-f", name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print("Production image, host-loopback MUD access, health and one-way relay checks passed")
