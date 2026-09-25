#!/bin/sh
# Standing Orders, in one command (macOS and Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/ap9000/standing-orders/main/install.sh | sh
#
# It checks what it needs (Node.js 22.13 or newer, git), installs the
# `standing-orders` command with npm, and starts it with your projects in
# ~/Projects. Nothing runs as root, and nothing is installed but the one npm
# package. Settings:
#   SO_PROJECTS=/path/to/projects   where your repositories live (default ~/Projects)
#   SO_VERSION=0.5.0                a particular release (default: the latest)
#   SO_NO_START=1                   install only; start later with `standing-orders up`
set -eu

say() { printf '%s\n' "$*"; }
stop() { printf '\nStanding Orders: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) stop "this installer is for macOS and Linux. On Windows, use WSL, or run: npx standing-orders up" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  stop "it needs Node.js 22.13 or newer, and none was found. Install it (https://nodejs.org, \`brew install node\`, or \`fnm install 22\`), then run this again."
fi
version=$(node -p 'process.versions.node')
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
  stop "it needs Node.js 22.13 or newer; this computer has $version. Update Node, then run this again."
fi
command -v git >/dev/null 2>&1 || stop "it needs git. Install it, then run this again."
command -v npm >/dev/null 2>&1 || stop "it needs npm, which comes with Node.js."

agents=""
for one in claude codex gemini; do
  if command -v "$one" >/dev/null 2>&1; then agents="$agents $one"; fi
done

package="${SO_PACKAGE:-standing-orders@${SO_VERSION:-latest}}"
say "Installing $package …"
if ! npm install -g "$package" --no-fund --no-audit --loglevel=error; then
  stop "npm couldn't install it. If it said permission denied, give npm a folder you own: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
fi
say "Installed $(standing-orders --version 2>/dev/null || echo standing-orders)."

if [ -z "$agents" ]; then
  say ""
  say "No coding agent was found (claude, codex or gemini). The app works without one;"
  say "install one when you want work built, for example: npm install -g @anthropic-ai/claude-code"
fi
if [ "$(uname -s)" = "Linux" ] && ! command -v bwrap >/dev/null 2>&1; then
  say ""
  say "Tip: install bubblewrap (apt install bubblewrap) so Claude and Gemini agents can't read"
  say "Standing Orders' own secrets on this computer. Codex is fenced without it."
fi

if [ "${SO_NO_START:-}" = "1" ]; then
  say ""
  say "Start it with: standing-orders up --project-root \"${SO_PROJECTS:-$HOME/Projects}\""
  exit 0
fi

projects="${SO_PROJECTS:-$HOME/Projects}"
mkdir -p "$projects"
say ""
say "Starting Standing Orders with your projects in $projects …"
exec standing-orders up --project-root "$projects"
