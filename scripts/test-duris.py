#!/usr/bin/env python3
"""Opt-in cross-repository check; generic npm tests never need a Duris checkout."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--duris", required=True, type=Path, help="Duris checkout with the native petition harness")
parser.add_argument("--full-game", action="store_true", help="build an isolated game and verify saves/copyover with the Node sink")
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
runner = args.duris.resolve() / "tests/async" / ("test_discord_game_journey.py" if args.full_game else "test_discord_petition_export.py")
if not runner.is_file():
    parser.error(f"Native runner not found: {runner}")
driver = "duris-game-sink.js" if args.full_game else "duris-integration.js"
subprocess.run(["python3", str(runner), "--node-driver", str(root / "scripts/testing" / driver)],
               check=True, cwd=root)
