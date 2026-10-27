# Darcy browser client

Fixed static assets for GitHub Pages. Private requests go directly to the pinned
agent enclave after attestation. This repository holds no owner key, inference
credential, backend source, or user workspace.

Content-hashed assets include subresource integrity checks. `checksums.json`
records the source commit and asset hashes. The HTML and GitHub account remain
trusted: changed HTML could replace both JavaScript and its integrity value.
GitHub Pages shares the account's origin across project sites; a dedicated domain
would give the app its own browser origin.

Create a passkey in your chosen provider, then confirm it. No password,
recovery-key file, or per-device import exists. WebAuthn PRF and HKDF derive the
workspace credential directly. Synced discoverable passkeys work on fresh
browsers without transferring a saved browser record. Each unlock verifies the
pinned enclave before sending its derived credential.

Initial provisioning requires the owner to create the passkey, then the operator
binds its public registration hash into the measured workspace configuration.
There is no unauthenticated first-claim endpoint. The previous credential is
retired; passkey enrollment is pending until that human step completes.

Brief app switches retain the credential in memory; 15 minutes in the background
or a fresh launch requires passkey unlock. Lock clears current windows sharing
this browser storage and leaves server tasks running. Only public enrollment
metadata is stored. No plaintext key or wrapped old key persists. Losing the
passkey may lose the workspace; choose a provider with suitable backup/recovery.
Browser code can read the derived credential while unlocked. Actual iPhone and
provider interaction needs a device check beyond the automated tests.
