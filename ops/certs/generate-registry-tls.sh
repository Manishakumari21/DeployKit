#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="${1:?usage: generate-registry-tls.sh <target-dir>}"
CA_KEY="$CERT_DIR/ca.key"
CA_CERT="$CERT_DIR/ca.crt"
LEAF_KEY="$CERT_DIR/private-key.pem"
LEAF_CERT="$CERT_DIR/fullchain.pem"

for f in "$CA_KEY" "$CA_CERT" "$LEAF_KEY" "$LEAF_CERT"; do
  if [ -e "$f" ]; then
    echo "refusing to overwrite existing file: $f" >&2
    exit 1
  fi
done

mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM

# Generate the local CA and keep its private key inside CERT_DIR only.
openssl genrsa -out "$CA_KEY" 4096
chmod 600 "$CA_KEY"
openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 365 \
  -subj "/CN=DeployKit local registry CA" -out "$CA_CERT"

# Generate the leaf key and certificate. Only the leaf key/cert are mounted.
openssl genrsa -out "$LEAF_KEY" 2048
chmod 600 "$LEAF_KEY"
openssl req -new -key "$LEAF_KEY" -subj "/CN=deploykit-registry-tls" -out "$WORK_DIR/server.csr"
printf 'subjectAltName=DNS:deploykit-registry-tls,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > "$WORK_DIR/server.ext"
openssl x509 -req -in "$WORK_DIR/server.csr" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$LEAF_CERT" -days 365 -sha256 -extfile "$WORK_DIR/server.ext"

# Fail if the leaf certificate and its private key do not match.
LEAF_PUBKEY="$(openssl x509 -in "$LEAF_CERT" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
KEY_PUBKEY="$(openssl pkey -in "$LEAF_KEY" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
if [ -z "$LEAF_PUBKEY" ] || [ -z "$KEY_PUBKEY" ] || [ "$LEAF_PUBKEY" != "$KEY_PUBKEY" ]; then
  echo "certificate and private key do not match" >&2
  exit 1
fi

# Validate the chain and expiry before treating the files as usable.
openssl x509 -in "$LEAF_CERT" -noout -checkend 86400
openssl verify -CAfile "$CA_CERT" "$LEAF_CERT"
echo "generated certificate files in $CERT_DIR"
