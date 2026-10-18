#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:?usage: generate-registry-tls.sh <target-dir>}"
TARGET_NAME="$(basename "$TARGET_DIR")"

# Fail closed before writing anything if the requested certificate directory
# (or a symlink/other file at the same path) already exists.
if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  echo "refusing to overwrite existing path: $TARGET_DIR" >&2
  exit 1
fi

# Stage in a temporary sibling directory so the target can be published
# atomically and incomplete/partial failure never leaves target files.
PARENT_DIR="$(dirname "$TARGET_DIR")"
mkdir -p "$PARENT_DIR"
WORK_DIR="$(mktemp -d "${PARENT_DIR}/.${TARGET_NAME}-stage.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM

CA_KEY="$WORK_DIR/ca.key"
CA_CERT="$WORK_DIR/ca.crt"
LEAF_KEY="$WORK_DIR/private-key.pem"
LEAF_CERT="$WORK_DIR/fullchain.pem"

openssl genrsa -out "$CA_KEY" 4096
chmod 600 "$CA_KEY"
openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 365 \
  -subj "/CN=DeployKit local registry CA" -out "$CA_CERT"

openssl genrsa -out "$LEAF_KEY" 2048
chmod 600 "$LEAF_KEY"
openssl req -new -key "$LEAF_KEY" -subj "/CN=deploykit-registry-tls" -out "$WORK_DIR/server.csr"
printf 'subjectAltName=DNS:deploykit-registry-tls,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > "$WORK_DIR/server.ext"
openssl x509 -req -in "$WORK_DIR/server.csr" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$LEAF_CERT" -days 365 -sha256 -extfile "$WORK_DIR/server.ext"
chmod 600 "$LEAF_KEY"

# Validate the leaf before publishing it as a BuildKit/gateway target. Parse
# actual SAN entries as individual records rather than trusting OpenSSL text
# output order.
SAN_OUTPUT="$(openssl x509 -in "$LEAF_CERT" -noout -ext subjectAltName 2>/dev/null || true)"
# OpenSSL traditionally emits both forms. Normalize only the historical variant
# to the current representation before exact matching.
SAN_OUTPUT="${SAN_OUTPUT//IP:127.0.0.1/IP Address:127.0.0.1}"
SAN_ENTRIES="$(printf '%s\n' "$SAN_OUTPUT" | tail -n +2 | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
san_present() {
  printf '%s\n' "$SAN_ENTRIES" | grep -Fxq -- "$1"
}

for expected_san in "DNS:deploykit-registry-tls" "DNS:localhost" "IP Address:127.0.0.1"; do
  if ! san_present "$expected_san"; then
    echo "certificate subjectAltName does not contain the required SANs" >&2
    exit 1
  fi
done

LEAF_PUBKEY="$(openssl x509 -in "$LEAF_CERT" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
KEY_PUBKEY="$(openssl pkey -in "$LEAF_KEY" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
if [ -z "$LEAF_PUBKEY" ] || [ -z "$KEY_PUBKEY" ] || [ "$LEAF_PUBKEY" != "$KEY_PUBKEY" ]; then
  echo "certificate and private key do not match" >&2
  exit 1
fi

# OpenSSL accepts both RSA key files through `pkey`; this proves the files
# have valid public-key serialization without constraining to RSA parsing in
# the comparison above.
openssl pkey -in "$CA_KEY" -pubout -outform DER >/dev/null 2>&1
openssl pkey -in "$LEAF_KEY" -pubout -outform DER >/dev/null 2>&1

# `verify` rejects invalid chains; a nonzero return fails closed.
openssl verify -CAfile "$CA_CERT" "$LEAF_CERT"

# Reject material that is near expiry now.
openssl x509 -in "$LEAF_CERT" -noout -checkend 86400

chmod 700 "$WORK_DIR"

# The CA private key is only needed to sign the leaf certificate. Remove it
# before publication so the published directory cannot expose it through the
# shared gateway/BuildKit mounts.
rm -f "$CA_KEY"
if [ -e "$CA_KEY" ]; then
  echo "failed to remove the CA private key before publication" >&2
  exit 1
fi

# Atomically publish the complete directory. If publish fails, caller can rerun
# only after deleting the failed (if any) target path manually; no files are
# overwritten by this script.
mv -T "$WORK_DIR" "$TARGET_DIR"
trap - EXIT HUP INT TERM

echo "generated certificate files in $TARGET_DIR"
# Publication uses an atomic same-filesystem directory rename. Full atomicity
# depends on filesystem semantics; if the rename fails, staging is removed.