# Repository-encrypted secret policy

Status: pilot implementation for DEN-1378, DEN-1382, and DEN-1383.

## Decision

Fiducia uses SOPS as the explicit encrypted-file format. Age recipients are the
local-development default; cloud KMS with short-lived workload identity is the
preferred CI mechanism when persistent CI decryption is necessary.

This mechanism is only for bounded development/bootstrap configuration. It
does not replace the production cloud-secret → External Secrets Operator →
Fiducia KV delivery path.

SOPS was selected over transparent Git filters because reviewers and CI can
distinguish plaintext from ciphertext directly. `git-crypt` and `transcrypt`
make checkout convenient, but their filters can conceal a configuration error.
BlackBox and raw age/GPG blobs add ceremony or lose structured-file behavior.

## Trust boundaries

- Customer and admin Supabase configurations have different recipients and
  must never share a decryption identity implicitly.
- Production Supabase, Shared Auth, SendGrid, Twilio, signing, pepper,
  service-role, and Fiducia KV-protection values are prohibited from this pilot.
- Public age recipients and KMS resource identifiers may be tracked. Private
  keys and cloud credentials may not.
- `.env.example` contains names and safe placeholders only. Plaintext `.env*`
  files stay ignored and are rejected if tracked.

## Pilot shape

The repository intentionally commits `.sops.yaml.example`, not an operational
`.sops.yaml` and not persistent ciphertext. Recipient ownership, recovery, and
offboarding must be approved before the first recoverable encrypted file is
committed. The E2E test creates ephemeral customer/admin key pairs and synthetic
ciphertexts to prove the complete cryptographic path without establishing a
new long-lived credential.

## Required evidence before persistent use

1. Name an owner and backup owner for each recipient/KMS policy.
2. Prove customer → admin and admin → customer denial.
3. Prove recipient removal, data-key rewrap, rotation, and rollback.
4. Prove CI never emits plaintext through logs, summaries, caches, or
   artifacts.
5. Scan history and rotate any credential that was ever committed in
   plaintext; rewriting history is not sufficient remediation.
