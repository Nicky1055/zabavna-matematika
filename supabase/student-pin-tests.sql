-- Run after both migrations. All synthetic fixtures are rolled back.
begin;
create temp table pin_test_results (name text, passed boolean);
grant all on pin_test_results to anon, authenticated;
create function pg_temp.pin_assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then raise exception 'PIN TEST FAILED: %', label; end if;
  insert into pin_test_results values (label, true);
end;
$$;
create function pg_temp.pin_reject(statement text, expected text, label text)
returns void language plpgsql as $$
declare actual text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics actual = returned_sqlstate;
    perform pg_temp.pin_assert(actual = expected, label);
    return;
  end;
  raise exception 'PIN TEST FAILED (allowed): %', label;
end;
$$;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ea000000-0000-4000-8000-000000000001','pin-a@example.invalid','{"school_name":"PIN school"}'),
 ('ea000000-0000-4000-8000-000000000002','pin-b@example.invalid','{"school_name":"PIN school"}');
insert into public.classes(id,teacher_id,class_name,school_name,class_code) values
 ('eb000000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-000000000001','PIN A','PIN school','MAT-PINA01'),
 ('eb000000-0000-4000-8000-000000000002','ea000000-0000-4000-8000-000000000002','PIN B','PIN school','MAT-PINB02');
insert into public.students(id,class_id,student_number,display_name,pin_code) values
 ('ec000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000001',1,'PIN pupil A','0123'),
 ('ec000000-0000-4000-8000-000000000002','eb000000-0000-4000-8000-000000000001',2,'PIN pupil B','4567'),
 ('ec000000-0000-4000-8000-000000000003','eb000000-0000-4000-8000-000000000002',1,'PIN pupil C','0123');
select pg_temp.pin_assert((select count(*)=3 from public.students where id::text like 'ec000000-%'),'same PIN allowed across classes');
insert into public.game_results(student_id,class_id,student_name,game_key,score,total_questions,stars)
values ('ec000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000001','PIN pupil A','training',1,1,1);
create temp table pin_test_token as select public.math_student_login(
 'ec000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000001','MAT-PINA01','0123')->'data'->>'session_token' as token;
grant select on pin_test_token to authenticated;
create function pg_temp.pin_session_valid()
returns boolean language sql security definer set search_path = '' as $$
  select (public.math_student_session((select token from pg_temp.pin_test_token))->>'ok')::boolean;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000001',true);
select pg_temp.pin_reject($s$insert into public.students(class_id,student_number,display_name,pin_code) values
 ('eb000000-0000-4000-8000-000000000001',3,'Duplicate','0123')$s$,'23505','same-class duplicate insert rejected');
select pg_temp.pin_reject($s$update public.students set pin_code='4567'
 where id='ec000000-0000-4000-8000-000000000001'$s$,'23505','same-class duplicate reset rejected');
select pg_temp.pin_assert(pg_temp.pin_session_valid(),
 'failed reset preserves existing session');
select pg_temp.pin_reject($s$update public.students set pin_code='123'
 where id='ec000000-0000-4000-8000-000000000001'$s$,'22023','invalid PIN rejected');
select pg_temp.pin_reject($s$select pin_code from public.students$s$,'42501','teacher cannot read PIN hashes');
select pg_temp.pin_reject($s$select * from math_private.pin_class_locks$s$,'42501','PIN locks remain private');
with changed as (update public.students set pin_code='0099'
 where id='ec000000-0000-4000-8000-000000000001' returning id)
select pg_temp.pin_assert(count(*)=1,'owner can reset PIN with returning') from changed;
select pg_temp.pin_assert(not pg_temp.pin_session_valid(),
 'successful reset revokes previous session');
update public.students set pin_code='0099' where id='ec000000-0000-4000-8000-000000000001';
select pg_temp.pin_assert(true,'unchanged own PIN is permitted when unique');
select pg_temp.pin_assert((select count(*)=1 from public.game_results
 where student_id='ec000000-0000-4000-8000-000000000001'),'PIN reset preserves game results');
select pg_temp.pin_reject($s$insert into public.students(class_id,student_number,display_name,pin_code) values
 ('eb000000-0000-4000-8000-000000000001',3,'Batch A','8888'),
 ('eb000000-0000-4000-8000-000000000001',4,'Batch B','8888')$s$,'23505','duplicate within one batch rejected');
select pg_temp.pin_assert((select count(*)=2 from public.students
 where class_id='eb000000-0000-4000-8000-000000000001'),'failed batch is atomic');
select pg_temp.pin_reject($s$insert into public.students(class_id,student_number,display_name,pin_code) values
 ('eb000000-0000-4000-8000-000000000002',2,'Foreign','0123')$s$,'42501','foreign-class duplicate does not disclose PIN usage');
select set_config('request.jwt.claim.sub','ea000000-0000-4000-8000-000000000002',true);
with changed as (update public.students set pin_code='7654'
 where id='ec000000-0000-4000-8000-000000000001' returning id)
select pg_temp.pin_assert(count(*)=0,'other teacher cannot reset PIN') from changed;

set local role anon;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.pin_reject($s$update public.students set pin_code='7654'
 where id='ec000000-0000-4000-8000-000000000001'$s$,'42501','anonymous caller cannot reset PIN');
select pg_temp.pin_assert((public.math_student_login('ec000000-0000-4000-8000-000000000001',
 'eb000000-0000-4000-8000-000000000001','MAT-PINA01','0123')->>'reason')='invalid_pin','old PIN no longer logs in');
select pg_temp.pin_assert((public.math_student_login('ec000000-0000-4000-8000-000000000001',
 'eb000000-0000-4000-8000-000000000001','MAT-PINA01','0099')->>'ok')::boolean,'new PIN logs in including leading zeros');
reset role;
select pg_temp.pin_assert((select pin_code=extensions.crypt('0099',pin_code) and pin_code<>'0099'
 from public.students where id='ec000000-0000-4000-8000-000000000001'),'changed PIN remains hashed');
select pg_temp.pin_assert(not exists(select 1 from math_private.pin_attempts
 where student_id='ec000000-0000-4000-8000-000000000001' and failures>0),'successful login clears failed attempts');
select jsonb_build_object('passed',count(*),'tests',jsonb_agg(name)) as pin_test_report from pin_test_results;
rollback;
