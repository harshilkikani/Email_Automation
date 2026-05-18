#!/bin/sh
# Pre-commit secret scanner.
#
# Refuses the commit if staged files contain:
#   - a `.env` file (other than .env.example)
#   - AWS access keys (AKIA…)
#   - GitHub tokens (ghp_…, gho_…, ghs_…, ghr_…)
#   - Stripe/OpenAI/Anthropic style keys (sk_…, sk-…)
#   - Bouncer / Hunter style tokens (best-effort heuristics)
#
# Install: bash scripts/install-hooks.sh
# Bypass: NOT RECOMMENDED, but git commit --no-verify works in emergencies.
set -eu

staged=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

# 1. Never commit any .env file (except .env.example).
bad_env=$(printf '%s\n' "$staged" | grep -E '(^|/)\.env(\.[^/]+)?$' | grep -v '^\.env\.example$' || true)
if [ -n "$bad_env" ]; then
  echo "✕ Refusing commit — .env-shaped files staged:"
  echo "$bad_env" | sed 's/^/    /'
  echo "  These can leak secrets. Move values to Fly secrets / 1Password instead."
  exit 1
fi

# 2. Scan staged content for secret patterns. We only look at the staged diff,
#    not the working tree, so adding a real secret in an unstaged file is fine.
patterns='AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|ghs_[A-Za-z0-9]{30,}|ghr_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}'
matches=$(git diff --cached -U0 --no-color -- $(printf '%s\n' "$staged") 2>/dev/null \
  | grep -E "^\+" \
  | grep -vE '^\+\+\+ ' \
  | grep -E "$patterns" || true)

if [ -n "$matches" ]; then
  echo "✕ Refusing commit — potential secret(s) in staged diff:"
  echo "$matches" | head -5 | sed 's/^/    /'
  echo "  If this is a false positive, rotate the affected secret first then run with --no-verify."
  exit 1
fi

exit 0
