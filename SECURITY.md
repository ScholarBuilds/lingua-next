# Security

NEXUS is a single-user local application. Keep the API on loopback. Do not expose
an unauthenticated instance directly to the Internet.

Service credentials must be entered by each user in Settings. Runtime databases,
vault keys, browser cookies, OAuth sessions, personal learning records, and local
screenshots are excluded from the public repository and starter package.

Public builds reject `NEXUS_BUNDLE_CONFIG=1`. Never distribute an encrypted
credential database together with its decryption key.

For a suspected secret exposure, revoke the credential with its provider first.
Do not paste working credentials or private data into public issues. Use GitHub
private vulnerability reporting when enabled.
