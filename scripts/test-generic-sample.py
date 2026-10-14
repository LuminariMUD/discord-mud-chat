#!/usr/bin/env python3
"""Build the generic C89/cJSON sample and exercise it with an independent peer."""
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
MAX = 1024 * 1024


def wire(record):
    return json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


class Peer:
    def __init__(self, binary, limit=0, token=None, outbound=False):
        env = dict(os.environ)
        env.pop("SAMPLE_TEST_TOKEN", None)
        if token is not None:
            env["SAMPLE_TEST_TOKEN"] = token
        self.process = subprocess.Popen([str(binary), str(limit), "outbound-only" if outbound else "echo"],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env)
        self.port = self.response()["port"]
        self.socket = None
        self.pending = b""

    def response(self):
        assert select.select([self.process.stdout], [], [], 5)[0], "sample control response timed out"
        line = self.process.stdout.readline()
        if not line:
            raise AssertionError(self.process.stderr.read().decode())
        return json.loads(line)

    def rpc(self, action="status", **kwargs):
        self.process.stdin.write(wire(dict(action=action, **kwargs)))
        self.process.stdin.flush()
        return self.response()

    def until(self, predicate):
        deadline = time.monotonic() + 5
        while True:
            result = self.rpc()
            if predicate(result):
                return result
            assert time.monotonic() < deadline, result
            time.sleep(0.005)

    def connect(self):
        self.socket = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.pending = b""
        self.until(lambda s: s["connected"])
        return self.socket

    def receive(self):
        while b"\n" not in self.pending:
            data = self.socket.recv(65536)
            assert data, "unexpected sample EOF"
            self.pending += data
        line, self.pending = self.pending.split(b"\n", 1)
        return json.loads(line)

    def __enter__(self):
        return self

    def __exit__(self, error_type, value, traceback):
        if self.socket:
            self.socket.close()
        if error_type is None:
            self.rpc("quit")
            self.process.wait(timeout=5)
            assert self.process.returncode == 0, self.process.stderr.read().decode()
        elif self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def run(binary):
    fixtures = json.loads((ROOT / "test/fixtures/mud-protocol/records.json").read_text())
    with Peer(binary) as peer:
        sock = peer.connect()
        # Both directions, arbitrary channels, escaped controls, and bytewise UTF-8.
        for item in fixtures["chat"]:
            record = json.loads(item["wire"])
            expected = dict(record, emoted=int(record.get("emoted", 0) == 1))
            expected.pop("extension", None)
            for byte in item["wire"].encode():
                sock.sendall(bytes([byte]))
            assert peer.receive() == expected
            assert peer.rpc("send", record=expected)["accepted"] == 1
            assert peer.receive() == expected
        # No dangling-fragment parsing, embedded-NUL prefix matching, or string coercion.
        bad = [b"null\n", b"not json\n", b'{"channel":"gossip","name":4,"message":"bad"}\n',
               b'{"channel":"gossip","name":"N","message":"bad","emoted":true}\n',
               b'{"channel":"gossip","name":"N","message":"bad","emoted":1e999}\n',
               b'{"channel":"gossip\\u0000hidden","name":"N","message":"bad"}\n', b"raw\0nul\n"]
        before = peer.rpc()
        sock.sendall(b"\r\n \t\n" + b"".join(bad) + b"x" * (MAX + 1))
        marker = dict(channel="a/b:Élite", name="@Name", message="literal \\u0000 preserved", emoted=0)
        sock.sendall(b"ignored suffix\n" + wire(marker))
        assert peer.receive() == marker
        stats = peer.until(lambda s: s["rejected"] == before["rejected"] + len(bad) + 1)
        assert stats["max_read_bytes"] <= 65536 and stats["max_recv_calls"] <= 32
        sock.sendall(wire(dict(marker, channel="adapter-rejected")))
        peer.until(lambda s: s["rejected"] == stats["rejected"] + 1)
        # Exact and one-byte-over output bounds, including serializer expansion.
        exact = dict(channel="gossip", name="Name", message="", emoted=0)
        exact["message"] = "x" * (MAX - len(wire(exact)) + 1)
        assert len(wire(exact)) == MAX + 1
        assert peer.rpc("send", record=exact)["accepted"] == 1
        assert peer.receive() == exact
        assert peer.rpc("send", record=dict(exact, message=exact["message"] + "x"))["accepted"] == 0
        assert peer.rpc("send", record=dict(exact, message='"' * (MAX // 2)))["accepted"] == 0
        # Incoming exact-sized records use the same budget and remain intact.
        sock.sendall(wire(exact))
        assert peer.receive() == exact
        # Short writes, EAGAIN/EINTR and complete-event order.
        peer.rpc("write_mode", value=1)
        short = dict(marker, message="🔥\\\"\n" * 30)
        peer.rpc("send", record=short)
        peer.rpc("send", record=marker)
        assert peer.receive() == short
        assert peer.receive() == marker
        peer.rpc("write_mode", value=0)
        # Single-client policy does not replace an active client.
        with socket.create_connection(("127.0.0.1", peer.port), timeout=5) as extra:
            assert extra.recv(1) == b""
        peer.until(lambda s: s["rejected_clients"] == 1)
        # A full queue includes the retained front; no partial JSON truncation.
        peer.rpc("pause")
        result = peer.rpc("fill", record=marker)
        assert result["accepted"] == result["queued_events"] == 256
        peer.rpc("resume")
        for _ in range(256):
            assert peer.receive() == marker
        peer.until(lambda s: s["queued_events"] == 0)
        peer.rpc("pause")
        result = peer.rpc("fill", record=exact)
        assert result["accepted"] == result["queued_events"] == 4
        assert result["queued_bytes"] == 4 * (MAX + 1)
        peer.rpc("write_mode", value=1)
        peer.rpc("resume")
        assert sock.recv(1), "expected a partial front record"
        partial = peer.rpc("send", record=marker)
        assert partial["accepted"] == 0
        assert partial["queued_bytes"] == 4 * (MAX + 1)
        # Pending state and an unfinished input record never reach the next client.
        sock.sendall(b'{"channel":"stale')
        sock.close()
        peer.until(lambda s: not s["connected"] and not s["queued_events"])
        peer.rpc("write_mode", value=0)
        sock = peer.connect()
        peer.rpc("resume")
        sock.sendall(wire(marker))
        assert peer.receive() == marker
        assert peer.pending == b""
        # Continuous EINTR consumes the finite per-pulse call budget.
        peer.rpc("write_mode", value=4)
        peer.rpc("send", record=marker)
        stats = peer.until(lambda s: s["max_send_calls"] == 32)
        assert stats["queued_events"] == 1
        peer.rpc("write_mode", value=3)  # EPIPE drops the whole pending event.
        assert sock.recv(1) == b""
        peer.until(lambda s: not s["connected"] and not s["queued_events"])
        peer.rpc("write_mode", value=0)
        sock = peer.connect()
        peer.rpc("read_mode", value=1)
        sock.sendall(wire(marker))
        peer.until(lambda s: s["max_recv_calls"] == 32)
        peer.rpc("read_mode", value=2)
        peer.rpc("read_mode", value=0)
        assert peer.receive() == marker
        peer.rpc("shutdown")
        assert sock.recv(1) == b""
        assert peer.rpc("send", record=marker)["accepted"] == 0
        peer.rpc("restart")
        sock = peer.connect()
        sock.sendall(wire(marker))
        assert peer.receive() == marker
    # Real game adapters may choose outbound-only operation; controls still work.
    with Peer(binary, outbound=True) as peer:
        sock = peer.connect()
        sock.sendall(wire(fixtures["controls"][1]) + wire(marker))
        stats = peer.until(lambda s: s["rejected"] == 1)
        assert stats["received"] == 0
        assert peer.rpc("send", record=marker)["accepted"] == 1
        assert peer.receive() == marker
    # Sample is loopback only. These synthetic auth bytes stand in for the local
    # side of a TLS terminator; the production Node client forbids plaintext auth.
    with Peer(binary, token="fixture-token") as peer:
        sock = peer.connect()
        assert not peer.rpc()["authenticated"]
        assert peer.rpc("send", record=marker)["accepted"] == 0
        sock.sendall(wire(marker) + b'{"channel":"auth","message":"fixture-token\\u0000wrong"}\n')
        peer.until(lambda s: s["rejected"] == 2)
        sock.sendall(wire(dict(channel="auth", message="wrong")))
        assert sock.recv(1) == b""
        peer.until(lambda s: s["auth_failures"] == 1 and not s["connected"])
        sock = peer.connect()
        sock.sendall(wire(fixtures["controls"][0]) + wire(fixtures["controls"][1]) + wire(marker))
        assert peer.receive() == marker
        assert peer.rpc()["authenticated"]
        sock.close()
        peer.until(lambda s: not s["connected"])
        peer.connect()
        assert not peer.rpc()["authenticated"]
    with Peer(binary, limit=128) as peer:
        sock = peer.connect()
        sock.sendall(b"x" * 129 + b"\n" + wire(marker))
        assert peer.receive() == marker
        assert peer.rpc()["rejected"] == 1


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="generic-mud-sample-") as temp:
        binary = Path(temp) / "peer"
        flags = ["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"] if os.getenv("SANITIZE") == "1" else []
        subprocess.run(["cc", "-std=c89", "-pedantic", "-Wall", "-Wextra", "-Werror", "-g", *flags,
                        "-Idocs/mud_example", "docs/mud_example/discord_bridge.c",
                        "scripts/testing/generic-sample-peer.c", "-lcjson",
                        "-Wl,--wrap=send", "-Wl,--wrap=recv", "-o", str(binary)], check=True, cwd=ROOT)
        run(binary)
    print("Generic C89 sample protocol, bounds, faults and lifecycle checks passed")
