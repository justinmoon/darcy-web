# Darcy browser client

Fixed static assets for GitHub Pages. Private requests go directly to the pinned
agent enclave after attestation. This repository holds no owner key, inference
credential, backend source, or user workspace.

Content-hashed assets include subresource integrity checks. `checksums.json`
records the source commit and asset hashes. The HTML and GitHub account remain
trusted: changed HTML could replace both JavaScript and its integrity value.
GitHub Pages shares the account's origin across project sites; a dedicated domain
would give the app its own browser origin.

Import the recovery-key file once per browser/home-screen install, then set up a
passkey in your chosen provider. WebAuthn PRF derives a wrapping key; IndexedDB
stores only the encrypted workspace key and public passkey metadata. Setup must
pass a decrypt check. Each unlock still verifies the pinned enclave before
sending the workspace key. There is no plaintext-storage fallback.

Brief app switches keep the key in memory; 15 minutes in the background or a
fresh launch requires passkey unlock. Lock clears in-memory access across current
Darcy windows sharing this browser storage; it does not stop server tasks.
Passkey sync does not sync the encrypted browser record. Keep the recovery file:
new devices, cleared browser data or lost passkeys require setup again. Browser
code can read the key while unlocked. Native iPhone/provider testing remains a
separate check from the automated crypto, storage and lifecycle tests.
