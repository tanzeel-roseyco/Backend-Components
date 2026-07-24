# Borrow Inventory and Provenance

This manifest records reusable code standardized into this library. Source
repositories were read-only. Repeated storefronts, dashboard copies, forks, and
product-specific UI were deduplicated into portable backend contracts rather
than copied as separate components.

## Shared backend and integration components

| Library component | Source provenance |
|---|---|
| `typescript/utilities/spam-submission-guard.ts` | `ElevateoCo/roseycorebuild/src/lib/leads/spam.ts` |
| `typescript/business-logic/lead-sequence-engine.ts` | `ElevateoCo/roseycorebuild/src/lib/leads/{engine,sequences,rate-limit,store}.ts`, `src/app/api/cron/sequences/route.ts` |
| `typescript/integrations/docusign-client.ts` | `ElevateoCo/KCF.2/property-intake-app/lib/docusign/{client,config,types,webhook-verify}.ts`, `app/api/webhooks/docusign/route.ts`, `lib/docusign/seller-status.ts` |
| `typescript/integrations/dotloop-client.ts` | `ElevateoCo/KCF.2/property-intake-app/lib/dotloop/{client,types,index}.ts` |
| `typescript/business-logic/signed-document-processor.ts` | `ElevateoCo/KCF.2/property-intake-app/lib/actions/process-signed-documents.ts`, `lib/docusign/client.ts` |
| `typescript/integrations/gotenberg-client.ts` | `ElevateoCo/KCF.2/property-intake-app/lib/pdf/gotenberg.ts` |
| `typescript/integrations/twilio-voice.ts` | `ElevateoCo/Calls-Elevateo/src/app/api/twilio/conference/{join,events}/route.ts` |
| `typescript/integrations/google-workspace-rest.ts` | `ElevateoCo/elevateo-intake/lib/server/{oauth-google,drive}.ts` |
| `typescript/infrastructure/resumable-file-transfer.ts` | `ElevateoCo/elevateo-intake/lib/server/{supabase,copy}.ts`, `app/api/cron/reconcile/route.ts` |
| `shared/sql/tenant-rls-reference*.sql` | `ElevateoCo/golden-path-starter/supabase/migrations/0001_example_tenant_isolation.sql`, `supabase/tests/rls_tenant_isolation.sql` |
| `typescript/infrastructure/workflow-lease.ts` | `TeamRoseyCo/instagram-intelligence` workflow lease implementation |
| `typescript/infrastructure/ssrf-safe-downloader.ts` | `TeamRoseyCo/instagram-intelligence/services/analyze/download.ts` |
| `typescript/infrastructure/ai-cost-guard.ts` | `TeamRoseyCo/instagram-intelligence/lib/cost/{withCostTag,rates}.ts` |
| `typescript/utilities/secret-redaction.ts` | `ElevateoCo/elevate-os/dashboard/src/lib/mc/redact.ts` |
| `typescript/integrations/telegram-intake.ts` | `TeamRoseyCo/proposal-bot/src/app/api/telegram/webhook/route.ts`, `src/bot/bot.ts`, `src/storage/{types,index}.ts` |
| `typescript/auth/portable-auth-core.ts` | `TeamRoseyCo/brotherhood/apps/desktop/src/main/{oauthLoopback,pkce}.ts`, `apps/server/src/auth/{googleVerifier,signIn}.ts`, `packages/db/{schema.sql,src/users.ts,src/seedInvites.ts}` |
| `typescript/infrastructure/agent-action-spool.ts` | `ElevateoCo/elevate-os/dashboard/src/lib/mc/{actions.ts,ax42ActionPolicy.mjs}`, `dashboard/src/lib/workspaces.ts` |
| `typescript/integrations/stripe-commerce.ts` | `ElevateoCo/Puxx/app/api/stripe/{webhook,checkout}/route.ts`, `lib/payments/stripe.ts`; `ElevateoCo/TecTiles/src/app/api/{create-checkout-session,webhook}/route.ts` |
| `typescript/business-logic/abandoned-cart-recovery.ts` | `ElevateoCo/cat-core.com/apps/admin/app/api/abandoned-carts/route.ts`, `abandoned-carts/send-email/route.ts` |
| `typescript/business-logic/quote-document-workflow.ts` | `ElevateoCo/Verbiest-Quote-Automation/src/lib/measurement/extract.ts`, quote PDF/Excel routes, `src/lib/emails/sendQuoteEmail.ts`, `src/lib/quotes/statusMachine.ts`, quote lease migrations |

## Existing library coverage retained

The repository already contains standardized components for Google Calendar,
Gmail, Search Console, OAuth token management, Prisma and Supabase clients,
generic webhooks, contact/newsletter/quiz/review workflows, schedulers, resilient
HTTP, HMAC authentication, technical indicators, trading signals, and rate
limiting. Inventory candidates that only repeated those capabilities were mapped
to these existing implementations instead of copied again.

## Canonical family decisions

- The storefront repositories `cat-core.com`, `christianstore.co`,
  `clarityskin.store`, `crypto-market.co`, `doggy-dog.com`, and `duskglow.store`
  are one code family. Only one canonical commerce implementation is borrowed.
- `anda-dashboard-dev` is treated as a duplicate of `anda-dashboard`.
- Dashboard and workspace copies are sources for portable workflow, auth, CRM,
  audit, and storage contracts; their client-specific UI and schemas are not
  copied into this backend library.
- Static marketing sites, UI templates, documentation-only repositories, empty
  repositories, releases, and backups are not backend components.

## Explicit exclusion

The GDPR erasure workflow is intentionally excluded by product decision. No GDPR
erasure component or test is present.
