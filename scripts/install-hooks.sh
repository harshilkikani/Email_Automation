#!/bin/sh
# Install Keres git hooks.
#
# Symlinks scripts/pre-commit.sh into .git/hooks/pre-commit so every commit is
# scanned for accidental secret leaks. Idempotent.
set -eu

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$repo_root" ]; then
  echo "Not in a git repo." >&2
  exit 1
fi

hook="$repo_root/.git/hooks/pre-commit"
src="$repo_root/scripts/pre-commit.sh"

if [ ! -f "$src" ]; then
  echo "Missing $src" >&2
  exit 1
fi

mkdir -p "$repo_root/.git/hooks"
cp "$src" "$hook"
chmod +x "$hook"
echo "Installed pre-commit hook at $hook"
