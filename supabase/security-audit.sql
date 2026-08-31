-- Read-only report. Contains schema/security metadata, not student records or PINs.
select jsonb_pretty(jsonb_build_object(
  'columns', (select jsonb_agg(to_jsonb(c)) from (
    select table_name, column_name, data_type, udt_name, is_nullable,
           column_default, character_maximum_length
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('profiles', 'classes', 'students', 'game_results')
    order by table_name, ordinal_position
  ) c),
  'constraints', (select jsonb_agg(to_jsonb(c)) from (
    select conrelid::regclass::text as table_name, conname, contype,
           pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid in ('public.profiles'::regclass, 'public.classes'::regclass,
                      'public.students'::regclass, 'public.game_results'::regclass)
  ) c),
  'policies', (select jsonb_agg(to_jsonb(p)) from pg_policies p
    where schemaname = 'public'
      and tablename in ('profiles', 'classes', 'students', 'game_results')),
  'grants', (select jsonb_agg(to_jsonb(g)) from information_schema.role_table_grants g
    where table_schema = 'public'
      and table_name in ('profiles', 'classes', 'students', 'game_results')),
  'column_grants', (select jsonb_agg(to_jsonb(g)) from information_schema.column_privileges g
    where table_schema = 'public'
      and table_name in ('profiles', 'classes', 'students', 'game_results')),
  'triggers', (select jsonb_agg(to_jsonb(t)) from (
    select tgrelid::regclass::text as table_name, tgname,
           pg_get_triggerdef(oid) as definition, tgfoid::regprocedure::text as function_name
    from pg_trigger where not tgisinternal
      and tgrelid in ('auth.users'::regclass, 'public.profiles'::regclass,
                     'public.classes'::regclass, 'public.students'::regclass,
                     'public.game_results'::regclass)
  ) t),
  'functions', (select jsonb_agg(to_jsonb(f)) from (
    select n.nspname as schema_name, p.oid::regprocedure::text as name,
           p.prosecdef as security_definer, p.proacl::text as privileges,
           pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  ) f),
  'extensions', (select jsonb_agg(jsonb_build_object('name', e.extname, 'schema', n.nspname))
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname in ('pgcrypto', 'pgtap'))
)) as security_report;
