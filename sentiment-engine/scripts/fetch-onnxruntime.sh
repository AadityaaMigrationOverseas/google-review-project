#!/usr/bin/env bash
# Downloads the ONNX Runtime release the supplied engine was built against.
set -euo pipefail

VERSION="${ORT_VERSION:-1.17.1}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/third_party/onnxruntime"

case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) PKG="onnxruntime-osx-x86_64-${VERSION}" ;;
  Darwin-arm64)  PKG="onnxruntime-osx-arm64-${VERSION}" ;;
  Linux-x86_64)  PKG="onnxruntime-linux-x64-${VERSION}" ;;
  Linux-aarch64) PKG="onnxruntime-linux-aarch64-${VERSION}" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

if [[ -f "${DEST}/include/onnxruntime_cxx_api.h" ]]; then
  echo "ONNX Runtime already present at ${DEST}"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
curl -fsSL -o "${TMP}/ort.tgz" \
  "https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}/${PKG}.tgz"
tar -xzf "${TMP}/ort.tgz" -C "${TMP}"
mkdir -p "$(dirname "${DEST}")"
rm -rf "${DEST}"
mv "${TMP}/${PKG}" "${DEST}"
echo "Installed ${PKG} -> ${DEST}"
