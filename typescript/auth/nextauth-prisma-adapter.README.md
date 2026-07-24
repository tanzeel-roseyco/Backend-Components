# NextAuth Prisma adapter

This is an Auth.js configuration and Prisma adapter wrapper. It adds defensive error serialization around account and session lookups, configures Google OAuth, and exports the Auth.js handlers and sign-in helpers.

## Using it

Install and configure `next-auth`, `@auth/prisma-adapter`, and a compatible Prisma client. Supply `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and the normal Auth.js secret. Optional variables control scopes, secure cookies, and dangerous email linking.

Database errors from the wrapped lookup methods are logged in a circular-safe form and rethrown. Session-token logging is truncated.

## Limits

This file assumes Prisma models compatible with the Auth.js adapter and is already opinionated about provider, session, and cookie configuration. Review those settings before copying it into an application. Dangerous email linking should remain disabled unless the provider's email assertions are trusted.
