#!/bin/sh

set -eu

repository='ty91/sky'
version=''
artifact_base_url=''
temporary_directory=''
sky_stage=''
skyd_stage=''

usage() {
  printf '%s\n' 'Usage: install.sh [--version <version>] [--artifact-base-url <url>]'
}

fail() {
  printf 'sky install: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$temporary_directory" ]; then
    rm -rf "$temporary_directory"
  fi
  if [ -n "$sky_stage" ]; then
    rm -f "$sky_stage"
  fi
  if [ -n "$skyd_stage" ]; then
    rm -f "$skyd_stage"
  fi
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail '--version requires a value.'
      version=$2
      shift 2
      ;;
    --artifact-base-url)
      [ "$#" -ge 2 ] || fail '--artifact-base-url requires a value.'
      artifact_base_url=${2%/}
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown option: $1"
      ;;
  esac
done

[ "$(uname -s)" = 'Darwin' ] || fail 'Only macOS is supported.'
[ "$(uname -m)" = 'arm64' ] || fail 'Only Apple Silicon is supported.'
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
command -v shasum >/dev/null 2>&1 || fail 'shasum is required.'
command -v tar >/dev/null 2>&1 || fail 'tar is required.'
[ -n "${HOME:-}" ] || fail 'HOME must be set.'

if [ -z "$version" ]; then
  [ -z "$artifact_base_url" ] || fail '--version is required with --artifact-base-url.'
  latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repository/releases/latest") || fail 'Could not resolve the latest release.'
  tag=${latest_url##*/}
  case "$tag" in
    v*) version=${tag#v} ;;
    *) fail "Latest release URL did not contain a version tag: $latest_url" ;;
  esac
fi

case "$version" in
  v*) version=${version#v} ;;
esac

case "$version" in
  ''|*[!0-9A-Za-z.-]*) fail "Invalid version: $version" ;;
esac

if [ -z "$artifact_base_url" ]; then
  artifact_base_url="https://github.com/$repository/releases/download/v$version"
fi

archive_name="sky-$version-darwin-arm64.tar.gz"
checksum_name="$archive_name.sha256"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/sky-install.XXXXXX") || fail 'Could not create a temporary directory.'

curl -fL --retry 3 -o "$temporary_directory/$archive_name" "$artifact_base_url/$archive_name" || fail "Could not download $archive_name."
curl -fL --retry 3 -o "$temporary_directory/$checksum_name" "$artifact_base_url/$checksum_name" || fail "Could not download $checksum_name."

if ! (
  cd "$temporary_directory"
  shasum -a 256 -c "$checksum_name" >/dev/null
); then
  fail 'Checksum verification failed.'
fi

archive_entries=$(tar -tzf "$temporary_directory/$archive_name") || fail 'Could not read the release archive.'
[ "$archive_entries" = 'sky' ] || fail 'Release archive must contain only sky.'
tar -xzf "$temporary_directory/$archive_name" -C "$temporary_directory" || fail 'Could not extract the release archive.'
[ -f "$temporary_directory/sky" ] || fail 'Release archive does not contain a regular sky executable.'
[ -x "$temporary_directory/sky" ] || fail 'Release archive sky is not executable.'

artifact_version=$("$temporary_directory/sky" --version) || fail 'Could not read the downloaded sky version.'
[ "$artifact_version" = "$version" ] || fail "Downloaded sky version $artifact_version does not match $version."

install_directory="$HOME/.local/bin"
if [ -d "$install_directory/sky" ] || [ -d "$install_directory/skyd" ]; then
  fail "Install targets must not be directories: $install_directory"
fi

mkdir -p "$install_directory" || fail "Could not create $install_directory."
sky_stage=$(mktemp "$install_directory/.sky.install.XXXXXX") || fail 'Could not stage sky.'
install -m 0755 "$temporary_directory/sky" "$sky_stage" || fail 'Could not stage sky.'
skyd_stage=$(mktemp "$install_directory/.skyd.install.XXXXXX") || fail 'Could not stage skyd.'
rm -f "$skyd_stage"
ln -s sky "$skyd_stage" || fail 'Could not stage skyd.'

mv -f "$sky_stage" "$install_directory/sky" || fail 'Could not install sky.'
sky_stage=''
mv -f "$skyd_stage" "$install_directory/skyd" || fail 'Could not install skyd.'
skyd_stage=''

printf 'Installed Sky %s to %s.\n' "$version" "$install_directory"

case ":${PATH:-}:" in
  *":$install_directory:"*) ;;
  *)
    printf 'Warning: %s is not on PATH. Add it, for example:\n  export PATH="%s:$PATH"\n' "$install_directory" "$install_directory" >&2
    ;;
esac
