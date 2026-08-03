#!/usr/bin/env bash
set -euo pipefail

SOPS_BIN="${SOPS_BIN:-sops}"
AGE_KEYGEN_BIN="${AGE_KEYGEN_BIN:-age-keygen}"

command -v "$SOPS_BIN" >/dev/null
command -v "$AGE_KEYGEN_BIN" >/dev/null

umask 077
work_dir="$(mktemp -d /tmp/fiducia-sops-test.XXXXXX)"

cleanup() {
  case "$work_dir" in
    /tmp/fiducia-sops-test.*) rm -rf -- "$work_dir" ;;
    *) printf 'refusing unsafe cleanup path\n' >&2; return 1 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

customer_key="$work_dir/customer.agekey"
admin_key="$work_dir/admin.agekey"
"$AGE_KEYGEN_BIN" -o "$customer_key" >/dev/null 2>&1
"$AGE_KEYGEN_BIN" -o "$admin_key" >/dev/null 2>&1
customer_recipient="$("$AGE_KEYGEN_BIN" -y "$customer_key")"
admin_recipient="$("$AGE_KEYGEN_BIN" -y "$admin_key")"

test "$customer_recipient" != "$admin_recipient"
test "$(stat -c '%a' "$customer_key")" = "600"
test "$(stat -c '%a' "$admin_key")" = "600"

printf 'PLANE=customer\nSYNTHETIC_TOKEN=fixture-customer-only\n' > "$work_dir/customer.env"
printf 'PLANE=admin\nSYNTHETIC_TOKEN=fixture-admin-only\n' > "$work_dir/admin.env"

"$SOPS_BIN" --encrypt --age "$customer_recipient" --input-type dotenv --output-type dotenv \
  "$work_dir/customer.env" > "$work_dir/customer.sops.env"
"$SOPS_BIN" --encrypt --age "$admin_recipient" --input-type dotenv --output-type dotenv \
  "$work_dir/admin.env" > "$work_dir/admin.sops.env"

if grep -Fq 'fixture-customer-only' "$work_dir/customer.sops.env"; then
  printf 'customer ciphertext contains plaintext\n' >&2
  exit 1
fi
if grep -Fq 'fixture-admin-only' "$work_dir/admin.sops.env"; then
  printf 'admin ciphertext contains plaintext\n' >&2
  exit 1
fi

SOPS_AGE_KEY_FILE="$customer_key" "$SOPS_BIN" --decrypt --input-type dotenv --output-type dotenv \
  "$work_dir/customer.sops.env" > "$work_dir/customer.out.env"
SOPS_AGE_KEY_FILE="$admin_key" "$SOPS_BIN" --decrypt --input-type dotenv --output-type dotenv \
  "$work_dir/admin.sops.env" > "$work_dir/admin.out.env"
cmp -s "$work_dir/customer.env" "$work_dir/customer.out.env"
cmp -s "$work_dir/admin.env" "$work_dir/admin.out.env"

if SOPS_AGE_KEY_FILE="$admin_key" "$SOPS_BIN" --decrypt "$work_dir/customer.sops.env" >/dev/null 2>&1; then
  printf 'admin key unexpectedly decrypted customer ciphertext\n' >&2
  exit 1
fi
if SOPS_AGE_KEY_FILE="$customer_key" "$SOPS_BIN" --decrypt "$work_dir/admin.sops.env" >/dev/null 2>&1; then
  printf 'customer key unexpectedly decrypted admin ciphertext\n' >&2
  exit 1
fi

sed '0,/ENC\[AES256_GCM/s//ENC[BROKEN/' "$work_dir/customer.sops.env" > "$work_dir/corrupt.sops.env"
if SOPS_AGE_KEY_FILE="$customer_key" "$SOPS_BIN" --decrypt "$work_dir/corrupt.sops.env" >/dev/null 2>&1; then
  printf 'corrupt ciphertext unexpectedly decrypted\n' >&2
  exit 1
fi

printf 'sops/age ephemeral round-trip OK: correct-plane access and wrong-plane denial verified\n'
