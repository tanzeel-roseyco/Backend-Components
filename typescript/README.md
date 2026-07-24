# TypeScript/Node.js Components

Production-ready TypeScript implementations of backend components.

## Components

### Authentication (`./auth/`)
- **rate-limiter.ts** — IP-based login rate limiter with configurable lockouts
- **cookie-auth-middleware.ts** — Cookie-based authorization with JWT verification
- More coming...

### Database (`./database/`)
- **supabase-client.ts** — Reusable Supabase client factory with singleton pattern
- More coming...

### API Middleware (`./api-middleware/`)
- **webhook-verifier.ts** — HMAC-SHA256 webhook signature verification (Calendly, ConvertKit, Stripe)
- **email-handler.ts** — Multi-service email handler with fallbacks (Resend, SendGrid, SMTP)
- More coming...

### Business Logic (`./business-logic/`)
- **contact-form-handler.ts** — Contact form processor with validation, storage, and notifications
- More coming...

### Utilities (`./utilities/`)
- **immutable-config.ts** — Immutable configuration container with environment variable support
- **hmac-token.ts** — HMAC token generation and verification for secure operations
- More coming...

## Installation

```bash
npm install
```

## Usage

```typescript
import { RateLimiter } from './auth/rate-limiter';

const limiter = new RateLimiter({
  maxAttempts: 5,
  lockoutMinutes: 15,
  storageBackend: 'memory',
});

const check = await limiter.checkLimit(ipAddress);
if (!check.allowed) {
  // Return 429 Too Many Requests
}
```

## Building

```bash
npm run build
```

## Testing

```bash
npm test
```

## Contributing

- Follow TypeScript strict mode
- Add JSDoc comments
- Include unit tests
- Add examples in usage section
