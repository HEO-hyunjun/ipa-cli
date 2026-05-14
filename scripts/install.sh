#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${IPA_INSTALL_BIN_DIR:-$HOME/.local/bin}"
LINK_PATH="$BIN_DIR/ipa"
CLI_PATH="$ROOT_DIR/packages/cli/dist/main.js"
YES=0
NO_RC=0

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--yes] [--no-rc]

Build and install ipa from this local workspace.

Options:
  --yes    Answer yes to shell rc PATH updates
  --no-rc  Do not prompt for shell rc PATH updates
  --help   Show this help
EOF
}

log() {
  printf '==> %s\n' "$1"
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

ask_yes_no() {
  local prompt="$1"
  local answer
  if [[ "$YES" == "1" ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    return 1
  fi
  read -r -p "$prompt [Y/n] " answer
  case "$answer" in
    ""|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

default_shell_rc() {
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) printf '%s\n' "$HOME/.zshrc" ;;
    bash)
      if [[ "$(uname -s)" == "Darwin" && -f "$HOME/.bash_profile" ]]; then
        printf '%s\n' "$HOME/.bash_profile"
      else
        printf '%s\n' "$HOME/.bashrc"
      fi
      ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

path_snippet() {
  if [[ "$BIN_DIR" == "$HOME/.local/bin" ]]; then
    printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
  else
    printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
  fi
}

append_path_to_rc() {
  local rc_file="$1"
  local snippet
  snippet="$(path_snippet)"
  mkdir -p "$(dirname "$rc_file")"
  touch "$rc_file"
  if grep -Fq "$snippet" "$rc_file" || grep -Fq "$BIN_DIR" "$rc_file"; then
    log "PATH already configured in $rc_file"
    return
  fi
  {
    printf '\n# IPA CLI\n'
    printf '%s\n' "$snippet"
  } >> "$rc_file"
  log "Added $BIN_DIR to PATH in $rc_file"
}

install_pnpm_if_needed() {
  if command -v pnpm >/dev/null 2>&1; then
    log "pnpm found: $(pnpm --version)"
    return
  fi

  local version spec
  version="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -n 1)"
  spec="pnpm${version:+@$version}"
  log "pnpm not found"

  if command -v corepack >/dev/null 2>&1; then
    log "Activating $spec with corepack"
    corepack enable
    corepack prepare "$spec" --activate
    return
  fi

  if ask_yes_no "Install $spec globally with npm?"; then
    npm install -g "$spec"
    return
  fi

  die "pnpm is required. Install pnpm or run corepack enable, then rerun this script"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --no-rc) NO_RC=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

cd "$ROOT_DIR"

command -v node >/dev/null 2>&1 || die "node is not installed"
command -v npm >/dev/null 2>&1 || die "npm is not installed"
log "node found: $(node --version)"
log "npm found: $(npm --version)"
install_pnpm_if_needed

log "Installing workspace dependencies"
pnpm install

log "Building packages"
pnpm run build

log "Linking ipa into $BIN_DIR"
mkdir -p "$BIN_DIR"
ln -sf "$CLI_PATH" "$LINK_PATH"
chmod +x "$CLI_PATH"

if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
  log "$BIN_DIR is already on PATH"
elif [[ "$NO_RC" == "1" ]]; then
  log "Skipped shell rc PATH update"
else
  rc_file="$(default_shell_rc)"
  if ask_yes_no "Add $BIN_DIR to PATH in $rc_file?"; then
    append_path_to_rc "$rc_file"
  else
    log "Skipped shell rc PATH update"
  fi
fi

cat <<EOF

ipa installed:
  $LINK_PATH -> $CLI_PATH

Next commands:
  ipa --help
  ipa profile init --vault ~/ipa
  ipa profile current
  ipa search "keyword"

If ipa is not found in this shell, run:
  source "$(default_shell_rc)"
EOF
