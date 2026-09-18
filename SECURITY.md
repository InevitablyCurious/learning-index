# Security Policy

The Open Knowledge Project is in pre-production alpha. Nothing here is running
in production, and no user data is at risk today — but the cryptographic and
protocol design decisions being made now are the ones that will carry that
weight later, so disclosure is genuinely welcome.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately through GitHub:

**<https://github.com/MorfascoLabs/bench/security/advisories/new>**

That opens a private advisory visible only to you and the maintainers. It needs
no email address and no prior contact.

Please include what you have — a partial report is better than none:

- What the vulnerability is
- How to reproduce it
- Which component or file is affected
- A suggested mitigation, if you have one

**What to expect.** This is a pre-MVP project with a very small maintainer
group, so we are not going to promise a response time we cannot honour. You
will get an acknowledgement, and if the report is valid you will be credited in
the advisory unless you would rather not be. If you have heard nothing after two
weeks, please comment on the advisory — that is a lapse on our side, not a
judgement on your report.

## Supported versions

During alpha, only the latest commit on `main` receives security updates.
There are no released versions to backport to yet.

## Scope

In scope:

- Anything in this repository
- Protocol design flaws
- Cryptographic weaknesses, including key handling, derivation, and the
  proxy re-encryption path

Out of scope:

- Vulnerabilities in third-party dependencies — please report those upstream,
  though we do want to hear if we are using a dependency unsafely
- Denial of service achievable by a single client against a local development
  stack
- Issues that require physical access to a machine already running the software
- Findings that depend on the documented development defaults (the local
  `docker compose` stack ships deliberately weak credentials and is bound to
  loopback by default; LAN exposure is opt-in, per the dashboard README's
  "Remote viewing" section)
