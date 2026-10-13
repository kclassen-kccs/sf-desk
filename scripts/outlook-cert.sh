#!/bin/sh
# Makes the HTTPS certificate SF Desk needs for the Outlook add-in (Outlook only loads add-ins over HTTPS):
# a small certificate authority of your own, and a certificate for "localhost" signed by it, in ./certs.
# Only the authority needs trusting, once:  sh scripts/outlook-cert.sh --trust  (asks for your Mac password).
# Uses the openssl that comes with macOS; nothing is downloaded.
set -eu
cd "$(dirname "$0")/.."
DIR="${SF_DESK_CERTS:-certs}"
mkdir -p "$DIR"
chmod 700 "$DIR"

if [ ! -f "$DIR/localhost.pem" ] || [ "${1:-}" = "--renew" ]; then
  cat > "$DIR/leaf.ext" <<'EOF'
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
EOF
  cat > "$DIR/ca.ext" <<'EOF'
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
  # The authority (valid 10 years) and the localhost certificate (825 days, the most macOS accepts).
  openssl genrsa -out "$DIR/sf-desk-ca-key.pem" 2048 2>/dev/null
  openssl req -new -key "$DIR/sf-desk-ca-key.pem" -subj "/CN=SF Desk local CA/O=SF Desk" -out "$DIR/ca.csr"
  openssl x509 -req -in "$DIR/ca.csr" -signkey "$DIR/sf-desk-ca-key.pem" -days 3650 -sha256 \
    -extfile "$DIR/ca.ext" -out "$DIR/sf-desk-ca.pem" 2>/dev/null
  openssl genrsa -out "$DIR/localhost-key.pem" 2048 2>/dev/null
  openssl req -new -key "$DIR/localhost-key.pem" -subj "/CN=localhost/O=SF Desk" -out "$DIR/localhost.csr"
  openssl x509 -req -in "$DIR/localhost.csr" -CA "$DIR/sf-desk-ca.pem" -CAkey "$DIR/sf-desk-ca-key.pem" \
    -CAcreateserial -days 825 -sha256 -extfile "$DIR/leaf.ext" -out "$DIR/localhost.pem" 2>/dev/null
  rm -f "$DIR"/*.csr "$DIR"/*.ext "$DIR"/*.srl
  chmod 600 "$DIR"/*-key.pem
  echo "Made $DIR/localhost.pem, signed by $DIR/sf-desk-ca.pem."
else
  echo "$DIR/localhost.pem already exists (use --renew to make a new one)."
fi

if [ "${1:-}" = "--trust" ]; then
  # Trust the authority for your user only (login keychain), so Outlook and Safari accept https://localhost.
  security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$DIR/sf-desk-ca.pem"
  echo "Trusted \"SF Desk local CA\" in your login keychain."
else
  echo "Next: trust it once with   sh scripts/outlook-cert.sh --trust"
fi
echo "Then restart SF Desk; it also listens on https://localhost:${HTTPS_PORT:-3443}."
