"""Publish and read news in an isolated Duris world before calling its real publisher."""

import hashlib
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile

# Reuse Duris' disposable world, MariaDB import, and Telnet journey fixtures.
sys.path.insert(0, str(Path.cwd() / "tests" / "async"))
import test_mariadb_combat_journey as journey
from run_world_quest_dual_backend import setup_run_root, wait_for_boot
from test_flight_network_journey import authority, command

OLD = b"11/20/26 - Previous fixture\n\nYesterday's update.\n"
SECTION = (
    "&+R11/21/26&n &+L-&n &+YBridge journey headline&n\n"
    "&+W------------------------------------------------&n\n\n"
    "&+CBridge journey details&n\n"
    "&+Y-&n The verified news command shows this new entry.\n"
    "  Read https://example.invalid/news for more.\n"
).encode()


def check():
    with tempfile.TemporaryDirectory(prefix="duris-discord-news-") as path:
        runtime = Path(path)
        _, critical, boot_log = setup_run_root(runtime)
        (runtime / "help").symlink_to(Path.cwd() / "help", target_is_directory=True)
        news = runtime / "lib" / "information" / "news"
        news.write_bytes(OLD)
        executable = runtime / "bin" / "server" / "dms"
        executable.parent.mkdir(parents=True)
        shutil.copy2(sys.argv[1], executable)
        with (runtime / "lib" / "misc" / "event_names").open("w") as names:
            subprocess.run(["bash", "scripts/event_names.sh", executable], stdout=names, check=True)

        with authority("mariadb", runtime) as (env, sql), boot_log.open("w") as boot_output:
            before = runtime / "news-before"
            stored = runtime / "news-stored"
            select = "SELECT HEX(content) FROM mud_info WHERE name='news'"
            before.write_bytes(bytes.fromhex(sql(select)))
            assert before.read_bytes() == OLD
            news.write_bytes(b"&+YDURIS PLAYER NEWS&n\n\n" + SECTION + b"\n" + OLD)
            imported = subprocess.run(
                ["bash", str(runtime / "scripts" / "import_help_to_prod.sh"), "--local", "--news-only"],
                env=env, input="yes\n", capture_output=True, text=True, timeout=90,
            )
            assert imported.returncode == 0, imported.stderr
            stored.write_bytes(bytes.fromhex(sql(select)))
            assert news.read_bytes() == stored.read_bytes()
            plain, tls, websocket = journey.available_ports()
            env.update(CRITICAL_COMMAND_JOURNAL_DIR=str(critical), DURIS_TLS_PORT=str(tls),
                       DURIS_WEBSOCKET_PORT=str(websocket), MAINTENANCE_STATE_FILE=str(runtime / "maintenance.state"))
            game = subprocess.Popen([executable, "-d", runtime, str(plain)], cwd=runtime, env=env,
                                    stdout=boot_output, stderr=subprocess.STDOUT)
            try:
                wait_for_boot(game, boot_log)
                player = journey.MudClient(plain)
                try:
                    journey.create_character(player, expected_room=None, account="Newsplayer",
                                             character="Newsreader", email="newsreader@example.invalid")
                    command(player, "toggle paging yes")
                    player.send("news")
                    player.expect("Bridge journey headline", timeout=30)
                    player.expect("The verified news command shows this new entry.", timeout=30)
                    player.expect("https://example.invalid/news", timeout=30)
                finally:
                    player.close()
            finally:
                game.send_signal(signal.SIGTERM)
                game.wait(timeout=60)

        def publish(url, *args, enabled=None):
            env = os.environ.copy()
            env.pop("DURIS_DISCORD_NEWS_ENABLED", None)
            if enabled is not None:
                env["DURIS_DISCORD_NEWS_ENABLED"] = enabled
            env["DURIS_DISCORD_NEWS_URL"] = url
            return subprocess.run(
                [sys.executable, "scripts/publish_discord_news.py", *args], env=env,
                capture_output=True, text=True, timeout=15,
            )

        args = ("publish", "--before", before, "--source", news, "--stored", stored, "--readback-verified")
        outage = os.environ["TEST_DURIS_NEWS_OUTAGE"]
        disabled = publish(outage, *args)
        assert disabled.returncode == 0 and "disabled" in disabled.stdout, disabled.stderr
        first = publish(outage, *args, enabled="TRUE")
        announcement_id = hashlib.sha256(SECTION).hexdigest()
        assert first.returncode != 0 and announcement_id in first.stderr, first.stdout + first.stderr
        retry = publish(os.environ["TEST_DURIS_NEWS_BRIDGE"], "retry", "--source", news, "--id",
                        announcement_id, enabled="TRUE")
        assert retry.returncode == 0 and "HTTP 200" in retry.stdout, retry.stdout + retry.stderr
        print(announcement_id)


if __name__ == "__main__":
    check()
