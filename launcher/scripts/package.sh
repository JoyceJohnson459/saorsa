#!/bin/sh
# Release files for the server's download directory (SAORSA_DOWNLOADS_DIR): each build with its checksum and a
# gzip copy (installers download the .gz, about half the size), plus VERSION. Regenerate all of them together:
# the .gz URL is cached under the build's checksum, so a stale .gz would fail every install's verification.
set -eu
cd "$(dirname "$0")/../dist"
for build in saorsa-macos-arm64 saorsa-macos-x64 saorsa-windows-x64.exe; do
  shasum -a 256 "$build" > "$build.sha256"
  gzip -9 -k -f "$build"
done
bun -e 'console.log((await Bun.file("../package.json").json()).version)' > VERSION
ls -l
