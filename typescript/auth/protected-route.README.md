# Protected React route

`ProtectedRoute` is a client-side React guard for admin-only screens backed by Supabase authentication. It displays a loading state while checking the session, redirects signed-out users, and signs out authenticated users who lack the expected admin flag.

## Using it

Wrap protected JSX with `ProtectedRoute`. Pass a test double through the `client` prop when needed, or let `createAuthClient` read `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The component uses React Router navigation and Tailwind classes for its loading display.

## Limits

This is a user-interface guard, not an authorization boundary. Supabase user metadata may be client-writable depending on project settings. Every privileged API and database operation must independently enforce authorization on the server.
