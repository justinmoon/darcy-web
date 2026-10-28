# Darcy browser client

Fixed static assets for GitHub Pages. Private requests go directly to the pinned
agent enclave after attestation. This repository holds no owner key, inference
credential, backend source, or user workspace.

Content-hashed assets include subresource integrity checks. `checksums.json`
records the source commit and asset hashes. The HTML and GitHub account remain
trusted: changed HTML could replace both JavaScript and its integrity value.
GitHub Pages shares the account's origin across project sites; a dedicated domain
would give the app its own browser origin.

This is one private workspace with invite-gated, self-service passkey setup.
Enter the shared invite code, create a passkey in your chosen provider, then
confirm it. The enclave initializes fresh encrypted storage and opens the chat.
No operator hash binding, account password, recovery-key file or browser-key
transfer is required. Later login needs only the passkey.

WebAuthn PRF and HKDF derive the workspace capability. Each connection verifies
the pinned enclave before sending an encrypted request. Only the invite hash
enters measured config; the invite is 128 random bits, never shipped in this
client. An invite holder cannot replace an existing workspace owner. Browser
storage contains only a registered flag and lock revision, not credentials.

Brief app switches keep an unlocked session; 15 minutes in the background or a
new launch needs passkey unlock. A fresh browser can choose Use existing passkey.
Lock clears current windows sharing this browser storage; server tasks continue.
Choose a passkey provider with suitable backup: losing the passkey can lose the
workspace. Served code, browser and provider remain trusted; the hosting account
shares its origin across Pages projects.

Tests cover real Chrome virtual WebAuthn PRF, Rust HTTP/auth, invitation failures,
reload/unlock, fresh storage, ownership checks, reset/re-enrollment, dropped
replies and attestation rejection. Separate live acceptance passed real browser
verification, encrypted TEE signup and full enclave restart, without model calls.
Native iPhone/provider interaction remains a device check. Initialization is for
an explicitly fresh disposable volume; this prototype is not a multitenant
billing service or an externally audited production service.
