-- Reverse only objects owned by this reference. pgcrypto may be shared and is retained.
-- Policies are owned by their tables and disappear with the table drops below.
drop table if exists public.tenant_records;
drop table if exists public.organization_members;
drop table if exists public.organizations;
drop function if exists public.is_organization_member(uuid);
