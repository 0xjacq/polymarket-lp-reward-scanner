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
- `SNAPSHOT_PUBLIC_URL` real deployment value if it is stored in local env files
- Vercel tokens and project-bound credentials
- GitHub tokens
- OpenAI or other provider API keys
- `.env` files with real values
- `.vercel/` local linkage files
- private keys, certificates, logs, build artifacts, and machine-local files

Use GitHub Actions secrets and Vercel environment variables for runtime configuration.

Before pushing, scan staged changes for common secret patterns:

```bash
git diff --cached --name-only
git diff --cached
```

If a real secret was committed or pushed, rotate it immediately in the owning service and remove it from Git history.
