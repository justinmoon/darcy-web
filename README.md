# Darcy browser client

Fixed static assets for GitHub Pages. Private requests go directly to the pinned
agent enclave after attestation. This repository holds no owner key, inference
credential, backend source, or user workspace.

Content-hashed assets include subresource integrity checks. `checksums.json`
records the source commit and asset hashes. The HTML and GitHub account remain
trusted: changed HTML could replace both JavaScript and its integrity value.
GitHub Pages shares the account's origin across project sites; a dedicated domain
would give the app its own browser origin.

The access key stays in tab memory and travels only inside encrypted requests.
Keep a private backup; it also unlocks the persistent workspace. No recovery flow
exists yet.
