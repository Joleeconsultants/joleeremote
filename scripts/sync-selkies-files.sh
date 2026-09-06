#!/usr/bin/env bash
# Pull Selkies nginx fancyindex header.html + footer.html into chrome/selkies-files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/chrome/selkies-files"
UPSTREAM_FILE="$DEST/UPSTREAM"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
need curl
need git

[ -f "$UPSTREAM_FILE" ] || die "missing $UPSTREAM_FILE"

parse_upstream() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$UPSTREAM_FILE" | head -n 1 || true)"
  [ -n "$line" ] || die "UPSTREAM missing ${key}="
  printf '%s\n' "${line#${key}=}"
}

REPO="$(parse_upstream repo)"
UPSTREAM_PATH="$(parse_upstream path)"
PINNED="$(parse_upstream commit)"
ARG="${1:-}"
TARGET="${ARG:-$PINNED}"
if [ "$ARG" = "latest" ]; then
  die "latest not implemented for files shell; pass a SHA or omit for pin"
fi

case "$REPO" in
  https://github.com/*)
    GH_SLUG="${REPO#https://github.com/}"
    GH_SLUG="${GH_SLUG%.git}"
    ;;
  *) die "unsupported repo URL: $REPO" ;;
esac

echo "sync-selkies-files: ${REPO} @ ${TARGET} (${UPSTREAM_PATH})"
for name in header.html footer.html; do
  url="https://raw.githubusercontent.com/${GH_SLUG}/${TARGET}/${UPSTREAM_PATH}/${name}"
  curl -fsSL "$url" -o "$DEST/$name"
  echo "sync-selkies-files: wrote $name ($(wc -c <"$DEST/$name") bytes)"
done

awk -v sha="$TARGET" '
  BEGIN { done = 0 }
  /^commit=/ { print "commit=" sha; done = 1; next }
  { print }
  END { if (!done) print "commit=" sha }
' "$UPSTREAM_FILE" > "$DEST/UPSTREAM.tmp"
mv "$DEST/UPSTREAM.tmp" "$UPSTREAM_FILE"
echo "sync-selkies-files: commit=${TARGET}"
