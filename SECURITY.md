# Security Policy

## Supported Scope

This repository is intended to be public and should not contain operational secrets or environment-specific credentials.

## Reporting

If you discover a security issue:

1. Do not open a public issue with exploit details or credentials
2. Report it privately to the project maintainer
3. Include affected area, reproduction details, and impact

## Secret Handling

The following must stay outside the repository:

- `BLOB_READ_WRITE_TOKEN`
- Vercel tokens and project-bound credentials
- GitHub tokens
- `.env` files with real values
- `.vercel/` local linkage files

Use GitHub Actions secrets and Vercel environment variables for runtime configuration.
