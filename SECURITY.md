# Security

DocRouter handles documents and provider credentials, so treat secrets and uploads carefully.

## Secrets

- Never commit `.env` files.
- Keep Supabase service-role keys server-side only.
- Use `V2_CREDENTIAL_ENCRYPTION_KEY` in production.
- Provider keys saved through V2 onboarding are encrypted and never returned by the API.

## Documents

Uploaded documents may contain financial or personal data. Local development stores uploads under `.docrouter/v2-uploads`, which is ignored by git.

## Reporting

For now, open a private security report or contact the repository owner directly. Avoid posting real credentials, private PDFs, bank statements, or invoices in public issues.

