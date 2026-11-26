#!/bin/sh
# Builds RiddimX for Apple Silicon and Intel, zips each app with its SHA-256, and publishes them as
# a GitHub release (tag v<version from package.json>). Installed apps find it and update themselves.
#
#   1. Bump "version" in package.json (e.g. 0.1.0 → 0.2.0) and commit.
#   2. Write what changed in release-notes.md (shown to the DJ in the app).
#   3. npm run release
#
# Publishing needs the GitHub CLI (brew install gh; gh auth login). Without it, the files are left in
# release/ with the steps to upload them by hand.
set -eu

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
NOTES=release-notes.md
[ -f "$NOTES" ] || printf 'RiddimX %s\n' "$VERSION" > "$NOTES"

FILES=""
for ARCH in arm64 x64; do
  if [ "$ARCH" = arm64 ]; then npm run package; else npm run package:intel; fi
  APP="release/RiddimX-darwin-$ARCH/RiddimX.app"
  ZIP="release/RiddimX-darwin-$ARCH.zip"
  rm -f "$ZIP" "$ZIP.sha256"
  /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
  /usr/bin/shasum -a 256 "$ZIP" | awk '{print $1}' > "$ZIP.sha256"
  FILES="$FILES $ZIP $ZIP.sha256"
done

# Windows (x64): built from this Mac, zipped without Mac metadata. It has no update-in-place: the app
# announces a new version and the DJ downloads it.
npm run package:win
WZIP="release/RiddimX-win32-x64.zip"
rm -f "$WZIP" "$WZIP.sha256"
(cd release && /usr/bin/ditto -c -k --norsrc --noextattr --noqtn --keepParent RiddimX-win32-x64 RiddimX-win32-x64.zip)
/usr/bin/shasum -a 256 "$WZIP" | awk '{print $1}' > "$WZIP.sha256"
FILES="$FILES $WZIP $WZIP.sha256"

if command -v gh >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  gh release create "$TAG" $FILES --repo raggaxe/riddimx --title "RiddimX $VERSION" --notes-file "$NOTES"
  echo "Publicado: $TAG"
else
  echo "GitHub CLI (gh) não está instalado. Para publicar à mão:"
  echo "  1. https://github.com/raggaxe/riddimx/releases/new  ·  tag: $TAG"
  echo "  2. Cole as novidades de $NOTES"
  echo "  3. Anexe:$FILES"
fi
