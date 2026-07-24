# TypeScript / Node.js Components

Production-ready TypeScript & Node implementations. Most were **borrowed from real
RoseyCo production codebases**, then generalized (secrets → env vars, client/PII
scrubbed, config parameterized) and adversarially reviewed.

## Authentication (`./auth/`)
| File | What it does |
|------|--------------|
| `rate-limiter.ts` | IP-based login rate limiter with pluggable storage + lockout/backoff |
| `cookie-auth-middleware.ts` | HTTP-only cookie auth: signed token issue/verify/revoke, blacklist, clock-skew tolerance |
| `google-oauth-token-manager.ts` | OAuth2 client with proactive token refresh + persistent token store (port interface) |
| `nextauth-prisma-adapter.ts` | Custom NextAuth adapter: safe error serialization, OAuth token refresh, env-gated email linking |
| `desktop-login-token-exchange.ts` | Secure code→session token exchange for desktop/Electron clients |
| `protected-route.tsx` | React route guard: session + admin-flag verification, redirect/sign-out, loading state |

## Database (`./database/`)
| File | What it does |
|------|--------------|
| `supabase-client.ts` | Supabase client factory (anon + service-role) with singleton pattern |
| `prisma-client-singleton.ts` | Serverless-safe Prisma singleton with dev global caching |

## Integrations (`./integrations/`)
| File | What it does |
|------|--------------|
| `multi-provider-llm.ts` | Unified LLM interface (Groq/Gemini/OpenAI) with priority fallback + per-user keys |
| `google-calendar.ts` | OAuth2 Calendar: event fetch, availability computation, create/delete |
| `google-gmail.ts` | Gmail list/filter by label/query, header extraction, pagination |
| `google-search-console-client.ts` | Type-safe GSC client: service-account auth, dimensions, date ranges |

## API Middleware (`./api-middleware/`)
| File | What it does |
|------|--------------|
| `webhook-verifier.ts` | HMAC-SHA256 webhook verification (Calendly, ConvertKit, Stripe) with constant-time compare |
| `email-handler.ts` | Multi-service email (Resend/SendGrid/SMTP) with automatic fallback |

## Business Logic (`./business-logic/`)
| File | What it does |
|------|--------------|
| `task-scheduler.ts` | Deterministic greedy scheduler: energy constraints, deadline priority, partial placement |
| `local-scheduler.ts` | Offline deterministic fallback scheduler |
| `contact-form-handler.ts` | Contact form processor with Zod validation, storage, notification |
| `calendly-webhook-handler.js` | Booking webhook: HMAC verify, persist, email-list suppression on booking |
| `newsletter-subscription-handler.js` | Dual-platform subscribe (DB + email-list API), multi-list, confirmation email |
| `quiz-assessment-handler.js` | Quiz pipeline: tiered tagging, personalized assessment email, consent-tracked storage |
| `review-request-campaign.js` | Post-booking review workflow: delay window, platform-by-location, rate limiting |
| `blog-post-notification.js` | Broadcast email on publish with auto key-point extraction |
| `blog-audit-system.js` | Admin blog management (list drafts + update/publish) with whitelist field validation |
| `poll-handler.js` | Survey collector: persist + IP/UA capture + admin notify (success even if email fails) |

## Utilities (`./utilities/`)
| File | What it does |
|------|--------------|
| `immutable-config.ts` | Immutable config container with env-var loading + validation |
| `hmac-token.ts` | HMAC-SHA256 signed tokens (RFC 8058 unsubscribe pattern) |
| `time-color-utils.ts` | Time parse/format, color mapping, class helpers, locale dates |
| `hijri-calendar.ts` | Gregorian ↔ Hijri conversion utilities |
| `seo-utils.ts` | Canonicalization + URL normalization + social/image constants |
| `sitemap-generator.ts` | Build-time XML sitemap from static + dynamic routes |
| `seo-ranking-tracker.js` | Scheduled GSC pull + batched (500) upserts (reusable batch-insert pattern) |
| `download-analytics-tracker.js` | Resource-download analytics: user info + IP + UA + attribution |
| `serverless-helpers.js` | Reusable serverless helpers: `escapeHtml`, client IP/UA extraction, standard handler response shape |

## Install

```bash
npm install
```

## Usage

```typescript
import { RateLimiter } from './auth/rate-limiter';

const limiter = new RateLimiter({ maxAttempts: 5, lockoutMinutes: 15, storageBackend: 'memory' });
const check = await limiter.checkLimit(ipAddress);
if (!check.allowed) { /* return 429 */ }
```

> `.js` files are Node serverless handlers (borrowed as-is and generalized). They run
> in any Node runtime; the header of each declares its required env vars and dependencies.

## Conventions
- TypeScript strict-friendly, no implicit `any`
- Secrets only via `process.env`
- JSDoc on exported functions; `NOTE` anchors on non-obvious logic
