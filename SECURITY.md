# Security Policy

## Reporting a vulnerability

Please report security issues privately, using the repository's private vulnerability reporting (GitHub Security Advisories) if enabled. Do not open a public issue with exploit details. Include the affected component, steps to reproduce and the potential impact.

## Operator responsibilities

Agent Mesh is self-hosted. Every operator must deploy their own relay and generate their own `MESH_KEY`. There is no shared instance and no default key. Never reuse a key from an example, a screenshot or another deployment, and never commit your key or your `.firebaserc`.

If you believe your key was exposed, rotate it immediately (see "Key rotation" in the README).
