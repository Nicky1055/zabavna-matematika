-- Apply after 20260831_teacher_isolation.sql. Existing pupils and PINs are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A write per class serializes PIN changes, including under snapshot isolation.
create table if not exists math_private.pin_class_locks (
  class_id uuid primary key references public.classes(id) on delete cascade,
  revision bigint not null default 0
);
revoke all on math_private.pin_class_locks from public, anon, authenticated;
alter table math_private.pin_class_locks enable row level security;

create or replace function math_private.hash_student_pin()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
begin
  if current_setting('role', true) in ('anon', 'authenticated')
    and (auth.uid() is null or not math_private.owns_class(new.class_id)) then
    raise exception 'Student class access denied' using errcode = '42501';
  end if;
  if new.pin_code is null or new.pin_code !~ '^[0-9]{4}$' then
    raise exception 'PIN must contain four digits' using errcode = '22023';
  end if;

  insert into math_private.pin_class_locks as locks(class_id) values (new.class_id)
    on conflict (class_id) do update set revision = locks.revision + 1;

  if exists (
    select 1 from public.students s
    where s.class_id = new.class_id and s.id is distinct from new.id
      and s.pin_code = extensions.crypt(new.pin_code, s.pin_code)
  ) then
    raise exception 'student_pin_in_use'
      using errcode = '23505', constraint = 'math_students_class_pin_unique';
  end if;

  new.pin_code := extensions.crypt(new.pin_code, extensions.gen_salt('bf', 10));
  delete from math_private.student_sessions where student_id = new.id;
  delete from math_private.pin_attempts where student_id = new.id;
  return new;
end;
$$;
revoke all on function math_private.hash_student_pin() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
