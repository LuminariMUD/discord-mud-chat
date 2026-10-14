#!/usr/bin/env python3
"""Verify native sample drift, patch applicability, and executable behavior."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "docs/mud_example/duris"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--duris", required=True, type=Path, help="checkout containing the native command harness and recorded history")
args = parser.parse_args()
duris = args.duris.resolve()
manifest = json.loads((SAMPLE / "manifest.json").read_text())
for relative, expected in manifest["sha256"].items():
    content = (SAMPLE / relative).read_bytes()
    assert hashlib.sha256(content).hexdigest() == expected, f"Sample hash changed: {relative}"
    if relative.startswith("net/"):
        assert content == (duris / "src" / relative).read_bytes(), f"Native sample drift: {relative}"


def blob(revision, path):
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=duris)


source_paths = {path for path in manifest["patch_files"] if path.startswith("src/")}
for relative in manifest["sha256"]:
    if relative.startswith("net/"):
        path = "src/" + relative
        source_paths.add(path)
        assert (SAMPLE / relative).read_bytes() == blob(manifest["tested_revision"], path), f"Tested revision drift: {path}"
changed_source = subprocess.check_output([
    "git", "diff", "--name-only", manifest["base_revision"], manifest["tested_revision"], "--", "src/"
], cwd=duris, text=True).splitlines()
assert set(changed_source) == source_paths, "Sample does not cover every native production source change"


spec = importlib.util.spec_from_file_location("native_paths", duris / "tests/async/_paths.py")
native_paths = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_paths)
functions = [native_paths.extract_function(path, signature) for path, signature in [
    ("actcomm.c", "void do_petition("), ("actwiz.c", "void do_ptell("),
    ("actcomm.c", "void send_to_gods("), ("interp.c", "void half_chop("),
    ("handler.c", "bool isname(const char *str, const char *namelist)"),
    ("comm.c", "void escape_act_dollars("),
]]
assert functions[0].count("discord_petition_export(") == 1
assert functions[1].count("discord_petition_export(") == 1
build = duris / "bin/tests"
build.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="discord-sample-", dir=build) as directory:
    temp = Path(directory)
    patched = temp / "patch-check"
    patched.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "sample-check"], cwd=patched, check=True)
    for path in manifest["patch_files"]:
        target = patched / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob(manifest["base_revision"], path))
        mode = subprocess.check_output(["git", "ls-tree", manifest["base_revision"], "--", path], cwd=duris).split()[0]
        target.chmod(0o755 if mode == b"100755" else 0o644)
    subprocess.run(["git", "add", "."], cwd=patched, check=True)
    subprocess.run(["git", "apply", "--check", str(SAMPLE / "integration.patch")], cwd=patched, check=True)
    subprocess.run(["git", "apply", str(SAMPLE / "integration.patch")], cwd=patched, check=True)
    for path in manifest["patch_files"]:
        assert (patched / path).read_bytes() == blob(manifest["tested_revision"], path), f"Patch drift: {path}"
    (temp / "petition_commands.inc").write_text("\n\n".join(functions))
    binary = temp / "harness"
    flags = ["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"] if os.getenv("SANITIZE") == "1" else []
    subprocess.run([
        "g++", "-std=c++20", "-Wall", "-Wextra", "-Werror", "-Og", "-g", *flags,
        f"-I{SAMPLE}", f"-I{native_paths.SRC}", f"-I{temp}",
        str(duris / "tests/async/discord_petition_export_harness.cpp"),
        str(SAMPLE / "net/discord_bridge.c"), str(SAMPLE / "net/discord_petition.c"),
        str(native_paths.SRC / "net/ansi.c"), str(native_paths.SRC / "net/unicode.c"),
        str(native_paths.SRC / "core/safe_format.c"), str(native_paths.HARNESS_STUBS),
        "-lcjson", "-lcrypto", "-o", str(binary),
    ], cwd=duris, check=True, timeout=120)
    subprocess.run([str(binary)], cwd=duris, check=True, timeout=60)
    subprocess.run(["node", str(ROOT / "scripts/testing/duris-integration.js"), str(binary)],
                   cwd=ROOT, check=True, timeout=90)
print("Duris sample hashes, native drift, clean-base patch, compiled copies and Node integration passed")
