# Supabase client factory

This factory creates cached Supabase clients for ordinary RLS-protected access and server-side service-role access.

## Using it

Build a configuration with `createSupabaseConfig`, which reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and optionally `SUPABASE_SERVICE_ROLE_KEY`. Use `SupabaseFactory.getClient` for normal access and `getAdmin` only in trusted server code.

Missing required credentials cause an immediate error. Each client type is cached for the lifetime of the process.

## Limits

The factory keeps a single instance per client type, so the first supplied configuration wins. It is not suitable for switching between multiple Supabase projects in one process. Never expose the admin client or service-role key to browser code.
