#!/usr/bin/env python3
"""Check the bridge image and Linux host-loopback topology without Discord."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading

parser = argparse.ArgumentParser(description=__doc__)
source = parser.add_mutually_exclusive_group()
source.add_argument("--image", help="test an existing local image and retain it")
source.add_argument("--build-network", choices=("default", "host"),
                    help="Docker build network when building the fixture image")
args = parser.parse_args()

ROOT = Path(__file__).resolve().parent.parent
# The fixture runs here; a remote daemon would make host-loopback evidence invalid.
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]
env = dict(os.environ)
for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
    env.pop(key, None)
subprocess.run([*DOCKER, "info", "--format", "{{.ServerVersion}}"], env=env, check=True)
# Export an inert context to check that local files stay out of the build.
with tempfile.TemporaryDirectory(prefix="mud-container-context-") as directory:
    context = Path(directory) / "context"
    context.mkdir()
    (context / "Dockerfile").write_text("FROM scratch\nCOPY . /\n", encoding="ascii")
    (context / ".dockerignore").write_bytes((ROOT / ".dockerignore").read_bytes())
    included = {"package.json", "src/index.js", "config/config.example.json"}
    excluded = {".env", "config/config.json", "config/local.js", "src/.env", "src/local.js",
                "src/node_modules/local.js"}
    for path in included | excluded:
        file = context / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.touch()
    result = Path(directory) / "result"
    subprocess.run([*DOCKER, "build", "--output", f"type=local,dest={result}", str(context)],
                   env=env, check=True)
    exported = {file.relative_to(result).as_posix() for file in result.rglob("*") if file.is_file()}
    assert exported == included, f"Unexpected contents in Docker context: {exported ^ included}"

if args.image is None:
    image = f"mud-discord-chat:integration-{os.getpid()}"
    build = [*DOCKER, "build", "-t", image]
    if args.build_network is not None:
        build += ["--network", args.build_network]
    if os.environ.get("CODEX_PROXY_CERT"):
        build += ["--secret", f"id=proxy_ca,src={os.environ['CODEX_PROXY_CERT']}"]
    subprocess.run([*build, "."], cwd=ROOT, env=env, check=True)
else:
    image = subprocess.check_output(
        [*DOCKER, "image", "inspect", "--format", "{{.Id}}", args.image],
        env=env, text=True).strip()

try:
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
                    record = dict(channel="petition", name="Fixture",
                                  message="Network namespace \u4f60\u597d \U0001f525", emoted=0)
                    connection.sendall((json.dumps(record, ensure_ascii=False) + "\n").encode())
                    while data := connection.recv(4096):
                        captured.append(data)
            except Exception as error:
                errors.append(error)

        thread = threading.Thread(target=peer, daemon=True)
        thread.start()
        name = f"mud-bridge-smoke-{os.getpid()}"
        command = [*DOCKER, "run", "--rm", "--pull", "never", "--name", name, "--network", "host",
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
finally:
    if args.image is None:
        subprocess.run([*DOCKER, "image", "rm", image], env=env, check=True)
print("Production image, host-loopback MUD access, health and one-way relay checks passed")
