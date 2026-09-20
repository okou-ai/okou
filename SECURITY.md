# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |

We only provide security updates for the latest release. We recommend always running the most recent version.

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

If you discover a security vulnerability, please report it responsibly by emailing us at:

**[contact@okou.ai](mailto:contact@okou.ai)**

### What to Include

To help us triage and resolve the issue quickly, please include as much of the following as possible:

- A description of the vulnerability and its potential impact
- The type of issue (e.g., SQL injection, XSS, authentication bypass, privilege escalation)
- Affected component(s) or source file path(s), if known
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code, if available
- Any special configuration required to reproduce

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your report within **72 hours**.
- **Assessment**: We will provide an initial assessment and expected timeline within **7 business days**.
- **Resolution**: We aim to resolve critical vulnerabilities within **30 days** of confirmation.
- **Communication**: We will keep you informed of our progress throughout the process.

## Disclosure Policy

We follow a **coordinated vulnerability disclosure** process:

1. The reporter submits the vulnerability privately to us.
2. We confirm and assess the issue.
3. We develop and test a fix.
4. We release the fix and publish a security advisory.
5. After the fix is released, the reporter is free to disclose the vulnerability publicly.

We ask that reporters give us a reasonable window of **90 days** from the initial report before any public disclosure, to ensure we have adequate time to address the issue.

## Safe Harbor

We consider security research conducted in accordance with this policy to be:

- **Authorized** under applicable anti-hacking laws
- **Exempt** from DMCA restrictions on circumvention of technological measures
- **Lawful and welcome** — we will not pursue legal action against researchers who follow this policy

To qualify for safe harbor, you must:

- Act in good faith
- Avoid accessing or modifying other users' data
- Not disrupt or degrade our services (no DoS testing)
- Not exploit vulnerabilities beyond what is necessary to demonstrate the issue
- Report any findings to us before disclosing publicly

## Scope

### In Scope

- The Okou platform and its public-facing services
- Code in this repository and related official repositories
- Authentication, authorization, and access control mechanisms
- Data handling and storage

### Out of Scope

- Third-party services and dependencies (report these to the respective maintainers)
- Social engineering attacks against Okou team members or users
- Physical attacks
- Denial-of-service attacks
- Issues already reported or known publicly

## Recognition

We appreciate the security research community's efforts in helping keep Okou and our users safe. With your permission, we will acknowledge your contribution in our security advisories.

While we do not currently operate a formal bug bounty program, we evaluate significant, responsibly disclosed vulnerabilities on a case-by-case basis for recognition or rewards.

## Security Updates

Security advisories will be published through [GitHub Security Advisories](https://github.com/okou-ai/okou/security/advisories). We recommend watching this repository to stay informed.
