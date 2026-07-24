/**
 * Supabase Client Factory
 * Reusable initialization for client-side and server-side Supabase operations.
 * Handles credential management, auth configuration, and fallback behavior.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

export class SupabaseFactory {
  private static clientInstance: SupabaseClient | null = null;
  private static adminInstance: SupabaseClient | null = null;

  /**
   * Get or create a client-side Supabase instance (anon key)
   * Use for client-side operations and RLS-protected queries
   */
  static getClient(config: SupabaseConfig): SupabaseClient {
    if (!this.clientInstance) {
      if (!config.url || !config.anonKey) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables');
      }

      this.clientInstance = createClient(config.url, config.anonKey);
    }

    return this.clientInstance;
  }

  /**
   * Get or create an admin client (service role key)
   * Use only for server-side admin operations, never expose to client
   */
  static getAdmin(config: SupabaseConfig): SupabaseClient {
    if (!this.adminInstance) {
      if (!config.url || !config.serviceRoleKey) {
        throw new Error(
          'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
        );
      }

      this.adminInstance = createClient(config.url, config.serviceRoleKey);
    }

    return this.adminInstance;
  }

  /**
   * Create a new client instance with custom config
   * Useful for testing or multiple Supabase projects
   */
  static createClient(url: string, key: string): SupabaseClient {
    return createClient(url, key);
  }

  /**
   * Reset singleton instances (useful for testing)
   */
  static reset(): void {
    this.clientInstance = null;
    this.adminInstance = null;
  }
}

/**
 * Convenience function to load config from environment
 */
export function createSupabaseConfig(): SupabaseConfig {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  }

  return {
    url,
    anonKey,
    serviceRoleKey,
  };
}

/**
 * Usage example:
 *
 * // In your app initialization
 * const config = createSupabaseConfig();
 * const client = SupabaseFactory.getClient(config);
 *
 * // In API routes
 * export async function GET(request) {
 *   const supabase = SupabaseFactory.getClient(config);
 *   const { data, error } = await supabase
 *     .from('users')
 *     .select('*')
 *     .eq('id', userId);
 *
 *   return { data, error };
 * }
 *
 * // For admin operations
 * export async function DELETE(request) {
 *   const admin = SupabaseFactory.getAdmin(config);
 *   const { error } = await admin
 *     .from('users')
 *     .delete()
 *     .eq('id', userId);
 *
 *   return { deleted: !error };
 * }
 */
