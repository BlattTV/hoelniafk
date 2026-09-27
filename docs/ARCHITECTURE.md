# Architektur

```
Hoelni Client Suite                         src/
│
├── Identity Manager                        identity/  repository.ts, identityService.ts, health.ts
│   ├── Minecraft Accounts                  minecraft/authService.ts, tokenCache.ts
│   ├── Discord Identities                  discord/discordService.ts
│   ├── Mail Identities                     mail/mailService.ts
│   └── Network Profiles                    network/networkService.ts
│
├── Session Manager                         minecraft/sessionManager.ts, mineflayerBot.ts
│   └── SessionInstance je (Identity × Server)
│
├── Communication
│   ├── Minecraft Chat                      SessionManager → rules.parseChatLine
│   ├── Mail Inbox                          mail/imapSource.ts, parse.ts, provider.ts
│   └── Discord OAuth/Link Status           core/oauth.ts, minecraft/linking.ts
│
├── Networking                              network/connector.ts (Bind/SOCKS5/HTTP), publicIp.ts
├── Credential Vault                        vault/vault.ts, keyProviders.ts, refs.ts
├── Automation / Rules                      core/rules.ts + config/rules.yaml, app.ts (Scheduler), ops/bulk.ts
└── Monitoring                              core/events.ts (SSE), identity/health.ts, core/audit.ts
```

`src/app.ts` ist die Composition Root; alle externen Abhängigkeiten (Bot-Factory,
IMAP-Quelle, IP-Erkennung, Microsoft-Token-Flow, Discord-API, OAuth-Token-Endpoint)
sind injizierbar – so laufen Tests und `npm run demo` ohne echte Accounts.

## Datenmodell

```
Identity
   ├── MinecraftIdentity       minecraft_identities   (1:1, uuid & msa_account UNIQUE)
   ├── DiscordIdentity         discord_identities     (1:1, discord_user_id UNIQUE)
   ├── MailIdentity            mail_identities        (1:1, address UNIQUE) → mail_accounts (Mailbox, ggf. geteilt)
   ├── NetworkProfile[]        network_profiles       (identity_id NOT NULL – nie geteilt)
   ├── RewardState             reward_states + reward_history
   └── SessionInstance         (Laufzeit) aus server_assignments: Account, Server, Network, Chat, State
```

* Ein Account kann gleichzeitig Sessions auf mehreren Servern haben (`server_assignments`).
* Ein NetworkProfile gilt pro Identity (`identities.network_profile_id`) und kann pro
  Session überschrieben werden (`server_assignments.network_profile_id`) – aber nur mit
  einem Profil **derselben** Identity.

## Isolationsregeln

| Ressource | Durchsetzung |
|---|---|
| Vault | `IdentityVault` akzeptiert nur `vault://identity/<eigene id>/…`; Ciphertext ist per AAD an die Ref gebunden |
| Minecraft-Token | prismarine-auth-Cache liegt im Identity-Vault; UUID/Account UNIQUE; Account-Wechsel hinter einer Identity wird abgewiesen |
| Mail | Zugriff nur über `mailboxForIdentity`; geteilte Mailboxen liefern nur Mails an die eigene Adresse; mehrdeutige Mails werden nie geraten; manuelle Zuordnung nur zu Identities derselben Mailbox; exklusive Mailboxen |
| Discord | `discord_user_id` UNIQUE; OAuth-`state` einmalig und an die Identity gebunden; Refresh-Token im Identity-Vault |
| Network | `getNetworkProfileFor(identity, profile)` bei jeder Verwendung (Default, Session-Override, Test, Proxy-Secret) |

## Sicherheit der lokalen Oberfläche

* Bindet nur an Loopback; Host-Header-Prüfung (DNS-Rebinding), Origin-Prüfung.
* Per-Start-API-Token (Header `x-hoelni-token`), OAuth-Callback nur mit gültigem `state`.
* Strikte CSP (`script-src 'self'`, keine Inline-Skripte, Remote-Bilder blockiert).
* Mail-HTML nur in `<iframe sandbox>` (keine Skripte, kein Same-Origin, keine Popups).
* DOM wird ausschließlich über Text-Nodes aufgebaut (kein `innerHTML` mit Fremddaten).
