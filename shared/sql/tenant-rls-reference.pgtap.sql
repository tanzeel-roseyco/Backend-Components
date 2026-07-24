begin;
select plan(11);

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Organization A'),
  ('00000000-0000-0000-0000-0000000000b1', 'Organization B');
insert into public.organization_members (organization_id, user_id) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000b001');
insert into public.tenant_records (organization_id, payload) values
  ('00000000-0000-0000-0000-0000000000a1', '{"name":"A"}'),
  ('00000000-0000-0000-0000-0000000000b1', '{"name":"B"}');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-00000000a001',
  true
);

select is((select count(*)::int from public.tenant_records), 1, 'member sees one tenant');
select is((select payload->>'name' from public.tenant_records), 'A', 'member sees own tenant');
select is_empty(
  $$ select 1 from public.tenant_records
     where organization_id = '00000000-0000-0000-0000-0000000000b1' $$,
  'cross-tenant reads are denied'
);
select lives_ok(
  $$ insert into public.tenant_records (organization_id)
     values ('00000000-0000-0000-0000-0000000000a1') $$,
  'own-tenant inserts are allowed'
);
select throws_ok(
  $$ insert into public.tenant_records (organization_id)
     values ('00000000-0000-0000-0000-0000000000b1') $$,
  '42501',
  null,
  'cross-tenant inserts are denied'
);

select is_empty(
  $$ update public.tenant_records set payload = '{"changed":true}'
     where organization_id = '00000000-0000-0000-0000-0000000000b1'
     returning 1 $$,
  'cross-tenant updates affect no rows'
);
select lives_ok(
  $$ update public.tenant_records set payload = '{"changed":true}'
     where organization_id = '00000000-0000-0000-0000-0000000000a1' $$,
  'own-tenant updates are allowed'
);
select is_empty(
  $$ delete from public.tenant_records
     where organization_id = '00000000-0000-0000-0000-0000000000b1'
     returning 1 $$,
  'cross-tenant deletes affect no rows'
);

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '', true);
select is((select count(*)::int from public.tenant_records), 0, 'missing auth.uid fails closed');

reset role;
select ok(
  not has_function_privilege('public', 'public.is_organization_member(uuid)', 'execute'),
  'SECURITY DEFINER helper is not executable by PUBLIC'
);

set local role service_role;
select is((select count(*)::int from public.tenant_records), 3, 'service role bypass sees all tenant rows');

select * from finish();
rollback;
