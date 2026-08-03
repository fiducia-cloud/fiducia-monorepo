# Encrypted development configuration

This directory is reserved for explicitly encrypted, non-production SOPS files.
Plaintext dotenv files, private age keys, production credentials, and decrypted
temporary files must never be committed.

The customer and admin planes use different recipient sets. Copy
`.sops.yaml.example` to a temporary or local `.sops.yaml` only after the
recipient owners, recovery path, and offboarding procedure are approved. Do not
commit a persistent ciphertext merely to demonstrate tooling; the committed
recipient must have an accountable owner and recoverable private key.

Run the fail-closed checks with:

```sh
npm run check:secrets
npm run test:secrets
npm run test:sops
```

`test:sops` generates both key pairs and both plaintext fixtures inside a
mode-0700 temporary directory. It proves correct-plane decryption,
customer/admin cross-plane denial, corrupt-ciphertext denial, and cleanup
without retaining a reusable key.
