#!/bin/bash
# One-time install: run ollama-proxy as a system LaunchDaemon so it starts at
# BOOT with no login. Run it with:
#
#     sudo /Users/botboy/.ollama-proxy/install-daemon.sh
#
# What it does:
#   1. kills any manually-started (nohup) proxy.js instances
#   2. installs the repo daemon plist to /Library/LaunchDaemons (root:wheel 0644)
#   3. bootstraps the daemon and verifies it listens on *:11434 and proxies
#      to Ollama on 127.0.0.1:11434
#
# Safe to re-run (bootout of a missing job is ignored).
set -euo pipefail

PROXY_DIR="/Users/botboy/.ollama-proxy"
LABEL="com.botboy.ollama-proxy"

log() { echo "[install-ollama-proxy] $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

# --- Bootstrap: make a fresh clone runnable --------------------------------
# All steps are idempotent and no-ops on an already-provisioned machine.
OWNER="${SUDO_USER:-$(whoami)}"
NODE_BIN=""

log "Ensuring runtime prerequisites (owner: $OWNER)..."

# 1. node symlink: launchd runs with a minimal PATH, so the plist needs an
#    absolute binary. Prefer the invoking user's node (nvm / homebrew).
if [ ! -e "$PROXY_DIR/node" ]; then
  NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(ls -d /Users/"$OWNER"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1 || true)"
  fi
  if [ -z "$NODE_BIN" ]; then
    for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
      if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
    done
  fi
  if [ -z "$NODE_BIN" ]; then
    echo "No node binary found. Install Node.js, then re-run." >&2
    exit 1
  fi
  ln -sfn "$NODE_BIN" "$PROXY_DIR/node"
  chown -h "$OWNER":staff "$PROXY_DIR/node"
  log "created node symlink -> $NODE_BIN"
else
  NODE_BIN="$(readlink "$PROXY_DIR/node" || true)"
  log "node symlink already present -> ${NODE_BIN:-<unreadable>}"
fi

# 2. dependencies (mongodb, used for request logging). Without them the proxy
#    still runs with logging disabled, so a failure here must not abort.
if [ ! -d "$PROXY_DIR/node_modules" ]; then
  NPM_BIN="$(dirname "${NODE_BIN:-/nonexistent}")/npm"
  if [ -x "$NPM_BIN" ]; then
    log "installing npm dependencies..."
    ( cd "$PROXY_DIR" && sudo -u "$OWNER" "$NPM_BIN" ci --omit=dev ) \
      || ( cd "$PROXY_DIR" && sudo -u "$OWNER" "$NPM_BIN" install --omit=dev ) \
      || log "WARNING: npm install failed; Mongo logging will be disabled"
  else
    log "WARNING: npm not found; Mongo logging will be disabled"
  fi
else
  log "node_modules already present"
fi

# 3. config.json is NEVER in git (auth.keys are real secrets that grant access
#    to an internet-forwarded port). Seed it from the template, and keep it
#    readable only by its owner.
if [ ! -f "$PROXY_DIR/config.json" ]; then
  install -m 0600 -o "$OWNER" -g staff \
    "$PROXY_DIR/config.json.example" "$PROXY_DIR/config.json"
  log "created config.json from template -- EDIT IT (models + auth.keys)"
else
  chmod 0600 "$PROXY_DIR/config.json"
  chown "$OWNER":staff "$PROXY_DIR/config.json"
  log "config.json present; mode tightened to 0600 (holds API keys)"
fi

log "Validating plist definition..."
plutil -lint "$PROXY_DIR/$LABEL.daemon.plist"

log "Killing any manually-started proxy.js instances..."
pkill -f "$PROXY_DIR/proxy.js" 2>/dev/null || true

log "Installing daemon plist to /Library/LaunchDaemons (root:wheel 0644)..."
install -m 0644 -o root -g wheel \
  "$PROXY_DIR/$LABEL.daemon.plist" \
  "/Library/LaunchDaemons/$LABEL.plist"

log "Starting daemon ($LABEL)..."
launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "/Library/LaunchDaemons/$LABEL.plist" 2>/dev/null \
  || launchctl kickstart -k "system/$LABEL"

sleep 3

log "--- launchd state ---"
launchctl print "system/$LABEL" | grep -E '^\s*(state|pid) =' || true

log "--- probes ---"
lsof -nP -iTCP:11434 -sTCP:LISTEN || { echo "nothing listening on 11434" >&2; exit 1; }
curl -s --noproxy '*' -o /dev/null -w 'LAN  http://192.168.0.100:11434/api/version -> %{http_code}\n' -m 5 http://192.168.0.100:11434/api/version || true
curl -s --noproxy '*' -o /dev/null -w 'local http://127.0.0.1:11434/api/version   -> %{http_code} (Ollama direct)\n' -m 5 http://127.0.0.1:11434/api/version || true

log "Done. ollama-proxy now starts at boot and restarts if it crashes."
