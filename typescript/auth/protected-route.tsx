/**
 * ProtectedRoute — React route guard for admin-only areas.
 *
 * Purpose:
 *   Wraps protected content and gates rendering on two conditions, checked in
 *   order: (1) a valid authenticated session exists, and (2) the session's user
 *   carries an `admin` flag in their auth metadata. Unauthenticated users are
 *   redirected to the login route. Authenticated-but-non-admin users are signed
 *   out first (to drop their session) and then redirected. While the async check
 *   is in flight, a loading spinner is shown so protected content never flashes.
 *
 * Required environment variables (client-side, Vite-style):
 *   - VITE_SUPABASE_URL       Supabase project URL.
 *   - VITE_SUPABASE_ANON_KEY  Supabase anon/public key.
 *   (Access is centralized in `createAuthClient` below — no secrets are inlined.)
 *
 * Key dependencies:
 *   - react, react-router-dom (useNavigate)
 *   - @supabase/supabase-js (auth session + sign-out)
 *   - Tailwind CSS utility classes for the loading state (styling only).
 *
 * AIDEV-NOTE: Adapted and generalized from a production codebase.
 * Security/ordering constraints:
 *   - The admin check MUST run after confirming a session; never trust
 *     `user_metadata.admin` without a valid session first.
 *   - `user_metadata` is client-writable in many auth setups; treat this guard
 *     as UX-level protection only. Every privileged API/server call MUST
 *     re-verify authorization server-side (e.g. via a service-role check).
 *   - Render returns `null` (not children) for the unauthorized branch so
 *     protected UI is never mounted while the redirect navigation resolves.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// AIDEV-NOTE: Original imported a shared client: `import { supabase } from '../../utils/supabase';`
// Inlined + generalized here so this module is self-contained for the library.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Minimal shape of the auth client this guard depends on. Declared explicitly so
 * the component can be tested/mocked without pulling the full Supabase surface.
 */
export interface AuthClient {
  auth: {
    getSession(): Promise<{
      data: { session: AuthSession | null };
      error: { message: string } | null;
    }>;
    signOut(): Promise<{ error: { message: string } | null }>;
  };
}

/** Session subset consumed by the guard. */
export interface AuthSession {
  user?: {
    // AIDEV-NOTE: `admin` lives in client-visible metadata; UX-gate only (see header).
    user_metadata?: { admin?: boolean } | null;
  } | null;
}

/**
 * Create a browser auth client from environment configuration.
 *
 * AIDEV-NOTE: Falls back to a harmless placeholder client when env vars are
 * absent so the app boots in environments where auth is not configured
 * (e.g. previews). The guard still fails closed — a placeholder client returns
 * no session, so users are redirected to login rather than granted access.
 */
export function createAuthClient(): SupabaseClient {
  // Vite exposes client env vars via import.meta.env.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const url = env.VITE_SUPABASE_URL ?? '';
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? '';

  if (!url || !anonKey) {
    // Fail-safe placeholder: no valid session is ever returned from it.
    console.warn('Auth credentials not configured. Admin features are disabled.');
    return createClient('https://placeholder.supabase.co', 'placeholder-key');
  }

  return createClient(url, anonKey);
}

export interface ProtectedRouteProps {
  /** Content rendered only when the visitor is a verified admin. */
  children: React.ReactNode;
  /** Route to redirect unauthorized/unauthenticated visitors to. */
  loginPath?: string;
  /**
   * Auth client to use. Defaults to one built from env config. Injectable for
   * testing and for sharing a single app-wide client instance.
   */
  client?: AuthClient;
}

/**
 * Route guard that renders `children` only for authenticated admin users.
 *
 * @param children  Protected content.
 * @param loginPath Redirect target for unauthorized visitors (default `/admin/login`).
 * @param client    Optional auth client override (defaults to env-configured client).
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  loginPath = '/admin/login',
  client,
}) => {
  const navigate = useNavigate();
  // null = check in progress; true/false = resolved authorization result.
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    // Resolve the client once per mount; prop wins over env-configured default.
    const authClient: AuthClient = client ?? createAuthClient();
    let cancelled = false;

    async function checkAuth(): Promise<void> {
      const {
        data: { session },
        error,
      } = await authClient.auth.getSession();

      // No valid session -> bounce to login.
      if (error || !session) {
        if (!cancelled) navigate(loginPath);
        return;
      }

      // Verify admin metadata. Non-admins are signed out before redirect so a
      // stale non-admin session cannot linger.
      const userMetadata = session.user?.user_metadata;
      if (!userMetadata?.admin) {
        await authClient.auth.signOut();
        if (!cancelled) navigate(loginPath);
        return;
      }

      if (!cancelled) setIsAuthorized(true);
    }

    void checkAuth();

    // Guard against setting state after unmount if the check resolves late.
    return () => {
      cancelled = true;
    };
  }, [client, loginPath, navigate]);

  // Loading state: shown while the async auth check is pending.
  if (isAuthorized === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        {/* AIDEV-NOTE: Neutral Tailwind color (border-gray-900) so the component
            is theme-agnostic; swap for a project accent color in consuming apps. */}
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  return isAuthorized ? <>{children}</> : null;
};

export default ProtectedRoute;
