# Development phases

| Phase | Content | Status |
|---|---|---|
| A | IdentityProfile + SQLite | done (migrations v1→v2) |
| B | MinecraftIdentity | done – Microsoft device code via prismarine-auth; real-account test pending |
| C | MailIdentity + IMAP/OAuth mailbox | done – LOCAL INTEGRATION tested; real provider test pending |
| D | Discord OAuth2 | done – LOCAL INTEGRATION tested (PKCE over HTTP); real Discord app pending |
| E | NetworkProfile | done – bind/SOCKS5/HTTP, guard, diagnosis, real socket tests |
| F | one complete identity | done – milestone view; see SETUP.md for the real first identity |
| G | multiple identities | done – dashboard, matrix, bulk, templates, clone |
| H | multi-server | done – same account on several servers, per-session network |
| I | monitoring / automation | done – reconciler, supervisor, metrics, logs, setup check |

See FINAL_STATUS.md for what still needs your credentials.
