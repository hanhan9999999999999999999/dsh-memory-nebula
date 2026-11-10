# Security

## What this project touches

`dsh-memory-nebula` reads memory stores on the local machine (meow-memory,
OpenViking, plain notes, SQLite) and serves a read-only viewer. It never writes
to those stores. The only writable state is under
`$DSH_HOME/memory-nebula/` (mutes, manual links, caches, logs, injected-ledger
files).

The HTTP surface is intended for one local user:

- it binds to loopback only;
- write routes require a loopback `Origin` and reject cross-site requests;
- static pages ship a restrictive CSP and `nosniff` / `no-store`;
- `/share` is the one route that deliberately exports memory **content** as a
  self-contained HTML file. Treat exported files as plaintext backups.

Do not expose the server to a public network. There is no account system, no
telemetry, and no upload path.

## Supported versions

Security fixes land on the latest published minor. Older minors are not
maintained separately.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

<https://github.com/hanhan9999999999999999999/dsh-memory-nebula/security/advisories/new>

Do not open a public issue for a vulnerability. Include the version, the
affected route or file, and a minimal reproduction when possible. Reports that
only need a configuration change will be answered with the setting rather than
a release.

## Out of scope

- running the server on a public interface;
- a malicious local user who can already read the memory database;
- exported snapshot files shared by the user;
- third-party memory adapters that execute their own code.
