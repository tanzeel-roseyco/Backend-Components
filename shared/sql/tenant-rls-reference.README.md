# Tenant row-level security reference

This SQL group demonstrates a small organization-based tenant boundary for Supabase/Postgres. The main migration creates organizations, memberships, and tenant records; enables and forces row-level security; and grants authenticated users access through membership policies.

Membership is checked by the `security definer` function `public.is_organization_member`, which fixes its search path and compares the current `auth.uid()` with `organization_members`. Authenticated members can read their organization and membership rows and can read, insert, update, or delete tenant records belonging to that organization.

Run `tenant-rls-reference.sql` as a privileged migration role. The companion pgTAP file verifies member access and cross-tenant denial. The down migration removes the example objects and is destructive.

This is a reference schema, not a drop-in migration for an existing database. It assumes Supabase's `auth.uid()` function and authenticated/anonymous/service roles exist. It defines no membership-management policies for normal users, no role hierarchy beyond a stored text field, and no application-specific audit or retention rules.
