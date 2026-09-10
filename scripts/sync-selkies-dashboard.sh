#!/usr/bin/env bash
# Re-vendor chrome/selkies-dashboard from the pinned (or given) Selkies commit.
# Overlay files listed in chrome/selkies-dashboard/OVERLAY are never overwritten.
# Does not copy selkies-web-core.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEST="$ROOT/chrome/selkies-dashboard"
UPSTREAM_FILE="$DEST/UPSTREAM"
OVERLAY_FILE="$DEST/OVERLAY"
PATCH_DIR="$ROOT/chrome/patches/selkies-dashboard"

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

need curl
need tar
need git

[ -f "$UPSTREAM_FILE" ] || die "missing $UPSTREAM_FILE"
[ -f "$OVERLAY_FILE" ] || die "missing $OVERLAY_FILE"
[ -d "$PATCH_DIR" ] || die "missing $PATCH_DIR"

parse_upstream() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$UPSTREAM_FILE" | head -n 1 || true)"
  [ -n "$line" ] || die "UPSTREAM missing ${key}="
  line="${line%$'\r'}"
  printf '%s\n' "${line#${key}=}"
}

REPO="$(parse_upstream repo)"
UPSTREAM_PATH="$(parse_upstream path)"
PINNED="$(parse_upstream commit)"
LICENSE="$(parse_upstream license)"

case "$REPO" in
  https://github.com/*)
    GH_SLUG="${REPO#https://github.com/}"
    GH_SLUG="${GH_SLUG%.git}"
    ;;
  *)
    die "unsupported repo URL: $REPO"
    ;;
esac

ARG="${1:-}"
TARGET=""
if [ -z "$ARG" ]; then
  TARGET="$PINNED"
  echo "sync: pinned commit $TARGET"
elif [ "$ARG" = "latest" ]; then
  echo "sync: resolving latest commit on $UPSTREAM_PATH"
  API_URL="https://api.github.com/repos/${GH_SLUG}/commits?path=${UPSTREAM_PATH}&per_page=1"
  CURL_AUTH=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    CURL_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  elif [ -n "${GH_TOKEN:-}" ]; then
    CURL_AUTH=(-H "Authorization: Bearer ${GH_TOKEN}")
  fi
  API_JSON="$(curl -fsSL "${CURL_AUTH[@]}" -H "Accept: application/vnd.github+json" "$API_URL")" || die "GitHub API request failed: $API_URL"
  TARGET="$(printf '%s' "$API_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['sha'] if isinstance(d,list) and d else '')")"
  [ -n "$TARGET" ] || die "could not parse latest SHA from GitHub API"
  echo "sync: latest $TARGET"
else
  TARGET="$ARG"
  echo "sync: requested $TARGET"
fi

is_overlay() {
  local rel="${1#./}"
  local pat
  while IFS= read -r pat || [ -n "$pat" ]; do
    pat="${pat%$'\r'}"
    case "$pat" in
      ""|\#*) continue ;;
    esac
    pat="${pat#./}"
    pat="${pat%/}"
    case "$rel" in
      "$pat"|"$pat"/*) return 0 ;;
    esac
  done < "$OVERLAY_FILE"
  return 1
}

should_skip_src() {
  local rel="${1#./}"
  case "$rel" in
    copy-core.js|copy-jsdb.js|src/selkies-core.js) return 0 ;;
    public|public/*) return 0 ;;
    node_modules|node_modules/*|dist|dist/*|.git|.git/*) return 0 ;;
  esac
  return 1
}

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "sync: fetching ${REPO} @ ${TARGET} (${UPSTREAM_PATH})"
TAR_URL="https://codeload.github.com/${GH_SLUG}/tar.gz/${TARGET}"
if ! curl -fsSL "$TAR_URL" | tar -xz -C "$TMP"; then
  die "failed to download/extract $TAR_URL"
fi

SRC="$(find "$TMP" -type d -path "*/${UPSTREAM_PATH}" | head -n 1 || true)"
[ -n "$SRC" ] && [ -d "$SRC" ] || die "tarball did not contain ${UPSTREAM_PATH}"

SRC_LIST="$TMP/src-files.txt"
: > "$SRC_LIST"
ALL_SRC="$TMP/all-src.txt"
(
  cd "$SRC"
  find . -type f ! -path './node_modules/*' ! -path './.git/*' ! -path './dist/*'
) > "$ALL_SRC"

while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  rel="${rel#./}"
  if is_overlay "$rel"; then
    continue
  fi
  if should_skip_src "$rel"; then
    continue
  fi
  printf '%s\n' "$rel" >> "$SRC_LIST"
  mkdir -p "$DEST/$(dirname "$rel")"
  cp -a "$SRC/$rel" "$DEST/$rel"
done < "$ALL_SRC"

ALL_DEST="$TMP/all-dest.txt"
(
  cd "$DEST"
  find . -type f ! -path './node_modules/*' ! -path './dist/*' ! -path './.git/*'
) > "$ALL_DEST"

while IFS= read -r rel || [ -n "$rel" ]; do
  [ -n "$rel" ] || continue
  rel="${rel#./}"
  if is_overlay "$rel"; then
    continue
  fi
  if should_skip_src "$rel"; then
    continue
  fi
  if ! grep -Fxq "$rel" "$SRC_LIST"; then
    rm -f "$DEST/$rel"
  fi
done < "$ALL_DEST"

PATCHES=()
if [ -f "$PATCH_DIR/series" ]; then
  while IFS= read -r name || [ -n "$name" ]; do
    name="${name%$'\r'}"
    case "$name" in
      ""|\#*) continue ;;
    esac
    PATCHES+=("$PATCH_DIR/$name")
  done < "$PATCH_DIR/series"
else
  while IFS= read -r p; do
    PATCHES+=("$p")
  done < <(ls -1 "$PATCH_DIR"/*.patch 2>/dev/null | sort)
fi

restore_clean_upstream() {
  echo "sync: restoring clean ${UPSTREAM_PATH} @ ${TARGET} (plus overlay)" >&2
  while IFS= read -r rel || [ -n "$rel" ]; do
    [ -n "$rel" ] || continue
    rel="${rel#./}"
    if is_overlay "$rel"; then
      continue
    fi
    if should_skip_src "$rel"; then
      continue
    fi
    mkdir -p "$DEST/$(dirname "$rel")"
    cp -a "$SRC/$rel" "$DEST/$rel"
  done < "$ALL_SRC"
  while IFS= read -r rel || [ -n "$rel" ]; do
    [ -n "$rel" ] || continue
    rel="${rel#./}"
    if is_overlay "$rel"; then
      continue
    fi
    if should_skip_src "$rel"; then
      continue
    fi
    if ! grep -Fxq "$rel" "$SRC_LIST"; then
      rm -f "$DEST/$rel"
    fi
  done < "$ALL_DEST"
}

if [ "${#PATCHES[@]}" -eq 0 ]; then
  echo "sync: no patches to apply"
else
  # Quilt-style: each patch builds on the previous. Check+apply in series so
  # later patches can depend on earlier rewires (e.g. jolee-shims imports).
  echo "sync: applying ${#PATCHES[@]} patch(es) in series order"
  for p in "${PATCHES[@]}"; do
    [ -f "$p" ] || die "patch listed but missing: $p"
    if ! git apply --check --directory=chrome/selkies-dashboard "$p"; then
      echo >&2
      echo "error: patch failed to apply: ${p#"$ROOT"/}" >&2
      echo "Refresh chrome/patches/selkies-dashboard/ against this upstream and re-run." >&2
      restore_clean_upstream
      echo "Working tree now has a clean copy of ${UPSTREAM_PATH} @ ${TARGET} plus overlay files." >&2
      echo "That failure is the signal a human/PR must refresh the patch series." >&2
      exit 1
    fi
    git apply --directory=chrome/selkies-dashboard "$p"
    echo "sync: applied ${p#"$ROOT"/}"
  done
fi

UP_TMP="$TMP/UPSTREAM.new"
awk -v sha="$TARGET" '
  BEGIN { done = 0 }
  /^commit=/ { print "commit=" sha; done = 1; next }
  { print }
  END { if (!done) print "commit=" sha }
' "$UPSTREAM_FILE" > "$UP_TMP"
cp "$UP_TMP" "$UPSTREAM_FILE"

echo "sync: overlay preserved, commit=${TARGET}, license=${LICENSE}"
echo "sync: done"
