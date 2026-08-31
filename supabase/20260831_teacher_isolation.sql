-- Run inside BEGIN/COMMIT, after security-audit.sql and the rollback tests.
-- No application records are deleted. Existing four-digit PINs become bcrypt hashes.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if exists (select 1 from public.students where pin_code is null
    or (pin_code !~ '^[0-9]{4}$' and pin_code !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$')) then
    raise exception 'Resolve invalid existing student PINs before applying this migration';
  end if;
end;
$$;

create schema if not exists math_private;
revoke all on schema math_private from public, anon, authenticated;
grant usage on schema math_private to authenticated;

create table if not exists math_private.student_sessions (
  token_hash text primary key,
  student_id uuid not null references public.students(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists math_student_sessions_student_idx on math_private.student_sessions(student_id);
create table if not exists math_private.pin_attempts (
  student_id uuid primary key references public.students(id) on delete cascade,
  failures integer not null default 0,
  locked_until timestamptz
);
revoke all on all tables in schema math_private from public, anon, authenticated;
alter table math_private.student_sessions enable row level security;
alter table math_private.pin_attempts enable row level security;

create or replace function math_private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;
create or replace function math_private.is_teacher()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('teacher', 'admin'));
$$;
create or replace function math_private.owns_class(p_class_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select math_private.is_admin() or exists (
    select 1 from public.classes c join public.profiles p on p.id = c.teacher_id
    where c.id = p_class_id and c.teacher_id = auth.uid() and p.role = 'teacher'
  );
$$;
revoke all on function math_private.is_admin(), math_private.is_teacher(), math_private.owns_class(uuid)
  from public, anon, authenticated;
grant execute on function math_private.is_admin(), math_private.is_teacher(), math_private.owns_class(uuid)
  to authenticated;

-- Preserve the old helper signature, without allowing callers to probe other users.
create or replace function public.is_admin(user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(user_id = auth.uid(), false) and math_private.is_admin();
$$;
revoke all on function public.is_admin(uuid) from public, anon, authenticated;
grant execute on function public.is_admin(uuid) to authenticated;

-- User-controlled signup metadata must never grant an administrator role.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, email, full_name, school_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', 'Teacher'),
    coalesce(new.raw_user_meta_data->>'school_name', new.raw_user_meta_data->>'schoolName'), 'teacher')
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Replace, rather than OR-combine with, the old broad permissive policies.
do $$
declare p record;
begin
  for p in select tablename, policyname from pg_policies where schemaname = 'public'
    and tablename in ('profiles', 'classes', 'students', 'game_results')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end;
$$;
alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.students enable row level security;
alter table public.game_results enable row level security;

revoke all on public.profiles, public.classes, public.students, public.game_results from public, anon, authenticated;
-- Also revoke any explicit column grants, which table-level REVOKE does not remove.
do $$
declare t record;
begin
  for t in select table_name, string_agg(quote_ident(column_name), ', ') as columns
    from information_schema.columns where table_schema = 'public'
      and table_name in ('profiles', 'classes', 'students', 'game_results') group by table_name
  loop
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.%I from public, anon, authenticated',
      t.columns, t.columns, t.columns, t.columns, t.table_name);
  end loop;
end;
$$;
grant select on public.profiles, public.classes, public.game_results to authenticated;
grant insert (id, email, full_name, school_name) on public.profiles to authenticated;
grant update (full_name, school_name) on public.profiles to authenticated;
grant insert (teacher_id, class_name, school_name, academic_year, class_code) on public.classes to authenticated;
grant update (class_name, school_name, academic_year, class_code) on public.classes to authenticated;
grant delete on public.classes, public.students, public.game_results to authenticated;
grant select (id, class_id, student_number, display_name, is_active, created_at) on public.students to authenticated;
grant insert (class_id, student_number, display_name, pin_code, is_active) on public.students to authenticated;
grant update (student_number, display_name, pin_code, is_active) on public.students to authenticated;

create policy math_profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or math_private.is_admin());
create policy math_profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid() and role = 'teacher');
create policy math_profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy math_classes_read on public.classes for select to authenticated
  using (math_private.is_admin() or (teacher_id = auth.uid() and math_private.is_teacher()));
create policy math_classes_insert on public.classes for insert to authenticated
  with check (math_private.is_admin() or (teacher_id = auth.uid() and math_private.is_teacher()
    and school_name = (select school_name from public.profiles where id = auth.uid())));
create policy math_classes_update on public.classes for update to authenticated
  using (math_private.is_admin() or (teacher_id = auth.uid() and math_private.is_teacher()))
  with check (math_private.is_admin() or (teacher_id = auth.uid()
    and school_name = (select school_name from public.profiles where id = auth.uid())));
create policy math_classes_delete on public.classes for delete to authenticated
  using (math_private.is_admin() or (teacher_id = auth.uid() and math_private.is_teacher()));

create policy math_students_read on public.students for select to authenticated
  using (math_private.owns_class(class_id));
create policy math_students_insert on public.students for insert to authenticated
  with check (math_private.owns_class(class_id));
create policy math_students_update on public.students for update to authenticated
  using (math_private.owns_class(class_id)) with check (math_private.owns_class(class_id));
create policy math_students_delete on public.students for delete to authenticated
  using (math_private.owns_class(class_id));
create policy math_results_read on public.game_results for select to authenticated
  using (math_private.owns_class(class_id));
create policy math_results_delete on public.game_results for delete to authenticated
  using (math_private.owns_class(class_id));

-- Keep the column name for compatibility, but never expose PINs or hashes to browsers.
update public.students set pin_code = extensions.crypt(pin_code, extensions.gen_salt('bf', 10))
  where pin_code ~ '^[0-9]{4}$';
create or replace function math_private.hash_student_pin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.pin_code is null or new.pin_code !~ '^[0-9]{4}$' then
    raise exception 'PIN must contain four digits' using errcode = '22023';
  end if;
  new.pin_code := extensions.crypt(new.pin_code, extensions.gen_salt('bf', 10));
  delete from math_private.student_sessions where student_id = new.id;
  delete from math_private.pin_attempts where student_id = new.id;
  return new;
end;
$$;
revoke all on function math_private.hash_student_pin() from public, anon, authenticated;
drop trigger if exists math_hash_student_pin on public.students;
create trigger math_hash_student_pin before insert or update of pin_code on public.students
  for each row execute function math_private.hash_student_pin();

create or replace function public.math_check_connection()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('ok', true, 'version', 1);
$$;

-- Class codes reveal only the minimal roster needed by the existing student login.
-- They do not grant access to PINs, results or teacher profiles.
create or replace function public.math_find_class(p_class_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.classes%rowtype;
begin
  if p_class_code is null or length(p_class_code) > 24 then
    return jsonb_build_object('ok', false, 'reason', 'class_not_found');
  end if;
  select * into c from public.classes where class_code = upper(btrim(p_class_code));
  if not found then return jsonb_build_object('ok', false, 'reason', 'class_not_found'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'id', c.id, 'class_name', c.class_name, 'school_name', c.school_name, 'class_code', c.class_code));
end;
$$;
create or replace function public.math_students_for_login(p_class_id uuid, p_class_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare roster jsonb;
begin
  if not exists (select 1 from public.classes where id = p_class_id and class_code = upper(btrim(p_class_code))) then
    return jsonb_build_object('ok', false, 'reason', 'class_not_found');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'class_id', class_id,
    'student_number', student_number, 'display_name', display_name) order by student_number), '[]'::jsonb)
  into roster from public.students where class_id = p_class_id and is_active is true;
  return jsonb_build_object('ok', true, 'data', roster);
end;
$$;
create or replace function public.math_student_login(p_student_id uuid, p_class_id uuid, p_class_code text, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.students%rowtype; a math_private.pin_attempts%rowtype;
  token text; expiry timestamptz := now() + interval '12 hours';
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_pin');
  end if;
  select st.* into s from public.students st join public.classes c on c.id = st.class_id
    where st.id = p_student_id and st.class_id = p_class_id
      and c.class_code = upper(btrim(p_class_code)) and st.is_active is true for update of st;
  if not found or s.pin_code is null then return jsonb_build_object('ok', false, 'reason', 'invalid_pin'); end if;
  insert into math_private.pin_attempts(student_id) values (s.id) on conflict do nothing;
  select * into a from math_private.pin_attempts where student_id = s.id for update;
  if a.locked_until > now() then return jsonb_build_object('ok', false, 'reason', 'rate_limited'); end if;
  if a.locked_until is not null then
    update math_private.pin_attempts set failures = 0, locked_until = null where student_id = s.id;
  end if;
  if s.pin_code <> extensions.crypt(p_pin, s.pin_code) then
    update math_private.pin_attempts set failures = failures + 1,
      locked_until = case when failures + 1 >= 5 then now() + interval '15 minutes' else null end
      where student_id = s.id;
    return jsonb_build_object('ok', false, 'reason', 'invalid_pin');
  end if;
  update math_private.pin_attempts set failures = 0, locked_until = null where student_id = s.id;
  delete from math_private.student_sessions where student_id = s.id and expires_at <= now();
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into math_private.student_sessions(token_hash, student_id, expires_at)
    values (encode(extensions.digest(token, 'sha256'), 'hex'), s.id, expiry);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('id', s.id, 'class_id', s.class_id,
    'student_number', s.student_number, 'display_name', s.display_name, 'session_token', token, 'expires_at', expiry));
end;
$$;

create or replace function public.math_student_session(p_session_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare identity jsonb;
begin
  if p_session_token is null or p_session_token !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'session_expired');
  end if;
  select jsonb_build_object('studentId', s.id, 'classId', c.id, 'studentNumber', s.student_number,
    'studentName', s.display_name, 'className', c.class_name, 'classCode', c.class_code,
    'expiresAt', ss.expires_at) into identity
    from math_private.student_sessions ss join public.students s on s.id = ss.student_id
      join public.classes c on c.id = s.class_id
    where ss.token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex')
      and ss.expires_at > now() and s.is_active is true;
  if identity is null then return jsonb_build_object('ok', false, 'reason', 'session_expired'); end if;
  return jsonb_build_object('ok', true, 'data', identity);
end;
$$;
create or replace function public.math_student_logout(p_session_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_session_token ~ '^[a-f0-9]{64}$' then
    delete from math_private.student_sessions where token_hash = encode(extensions.digest(p_session_token, 'sha256'), 'hex');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
create or replace function public.math_save_game_result(p_session_token text, p_game_key text,
  p_score integer, p_total_questions integer, p_stars integer, p_time_spent_seconds integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare identity jsonb; result_id uuid;
begin
  identity := public.math_student_session(p_session_token);
  if not (identity->>'ok')::boolean then return identity; end if;
  if p_game_key is null or p_game_key not in ('training','bingo','families','robot','treasure','secret_code','balloons')
    or p_score is null or p_total_questions is null or p_stars is null
    or p_score < 0 or p_total_questions < 1 or p_score > p_total_questions or p_stars < 0
    or p_time_spent_seconds < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_result');
  end if;
  insert into public.game_results(student_id, class_id, student_name, game_key,
    score, total_questions, stars, time_spent_seconds)
  values ((identity->'data'->>'studentId')::uuid, (identity->'data'->>'classId')::uuid,
    identity->'data'->>'studentName', p_game_key, p_score, p_total_questions, p_stars, p_time_spent_seconds)
  returning id into result_id;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('id', result_id));
end;
$$;

revoke all on function public.math_check_connection(), public.math_find_class(text),
  public.math_students_for_login(uuid,text), public.math_student_login(uuid,uuid,text,text),
  public.math_student_session(text), public.math_student_logout(text),
  public.math_save_game_result(text,text,integer,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.math_check_connection() to anon, authenticated;
grant execute on function public.math_find_class(text), public.math_students_for_login(uuid,text),
  public.math_student_login(uuid,uuid,text,text), public.math_student_session(text),
  public.math_save_game_result(text,text,integer,integer,integer,integer) to anon;
grant execute on function public.math_student_logout(text) to anon, authenticated;

create index if not exists math_classes_teacher_idx on public.classes(teacher_id);
create index if not exists math_students_class_idx on public.students(class_id);
create index if not exists math_results_class_time_idx on public.game_results(class_id, played_at desc);
notify pgrst, 'reload schema';
