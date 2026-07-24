-- Generic Supabase/Postgres tenant boundary adapted from ElevateoCo/golden-path-starter.
create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  primary key (organization_id, user_id)
);

create table if not exists public.tenant_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tenant_records_organization_id_idx
  on public.tenant_records(organization_id);

-- SECURITY DEFINER avoids recursive membership RLS; the fixed search path prevents shadowing.
create or replace function public.is_organization_member(candidate_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members membership
    where membership.organization_id = candidate_id
      and membership.user_id = auth.uid()
  );
$$;
revoke all on function public.is_organization_member(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_organization_member(uuid) to authenticated, service_role;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.tenant_records enable row level security;
alter table public.organizations force row level security;
alter table public.organization_members force row level security;
alter table public.tenant_records force row level security;

drop policy if exists organizations_member_select on public.organizations;
create policy organizations_member_select on public.organizations
  for select to authenticated using (public.is_organization_member(id));

drop policy if exists organization_members_self_select on public.organization_members;
create policy organization_members_self_select on public.organization_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists tenant_records_member_select on public.tenant_records;
create policy tenant_records_member_select on public.tenant_records
  for select to authenticated using (public.is_organization_member(organization_id));

drop policy if exists tenant_records_member_insert on public.tenant_records;
create policy tenant_records_member_insert on public.tenant_records
  for insert to authenticated with check (public.is_organization_member(organization_id));

drop policy if exists tenant_records_member_update on public.tenant_records;
create policy tenant_records_member_update on public.tenant_records
  for update to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

drop policy if exists tenant_records_member_delete on public.tenant_records;
create policy tenant_records_member_delete on public.tenant_records
  for delete to authenticated using (public.is_organization_member(organization_id));

revoke all on public.organizations, public.organization_members, public.tenant_records from public, anon, authenticated;
grant select on public.organizations, public.organization_members to authenticated;
grant select, insert, update, delete on public.tenant_records to authenticated;
grant all on public.organizations, public.organization_members, public.tenant_records to service_role;
