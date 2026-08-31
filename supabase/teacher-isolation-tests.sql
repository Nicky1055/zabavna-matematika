-- Run after the migration in one transaction; ALWAYS roll back these fixtures.
create temp table math_test_results (name text, passed boolean);
grant all on math_test_results to anon, authenticated;
create temp table math_test_tokens (name text, token text);
grant all on math_test_tokens to anon, authenticated;
create function pg_temp.assert_true(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then raise exception 'SECURITY TEST FAILED: %', label; end if;
  insert into math_test_results values (label, true);
end;
$$;
create function pg_temp.denied(statement text, label text)
returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when insufficient_privilege then
    insert into math_test_results values (label, true);
    return;
  end;
  raise exception 'SECURITY TEST FAILED (request allowed): %', label;
end;
$$;
create function pg_temp.affected(statement text, expected integer, label text)
returns void language plpgsql as $$
declare actual integer;
begin
  execute statement;
  get diagnostics actual = row_count;
  perform pg_temp.assert_true(actual = expected, label);
end;
$$;

insert into auth.users(id, email, raw_user_meta_data)
values
 ('fa000000-0000-4000-8000-000000000001', 'math-rls-a@example.invalid', '{"full_name":"RLS A","school_name":"Same school","role":"admin"}'),
 ('fa000000-0000-4000-8000-000000000002', 'math-rls-b@example.invalid', '{"full_name":"RLS B","school_name":"Same school"}'),
 ('fa000000-0000-4000-8000-000000000003', 'math-rls-admin@example.invalid', '{"full_name":"RLS Admin","school_name":"Same school"}');
select pg_temp.assert_true((select role = 'teacher' from public.profiles where id='fa000000-0000-4000-8000-000000000001'), 'signup cannot request admin');
update public.profiles set role='admin' where id='fa000000-0000-4000-8000-000000000003';
insert into public.classes(id, teacher_id, class_name, school_name, class_code) values
 ('fb000000-0000-4000-8000-000000000001','fa000000-0000-4000-8000-000000000001','RLS A','Same school','MAT-RLSA01'),
 ('fb000000-0000-4000-8000-000000000002','fa000000-0000-4000-8000-000000000002','RLS B','Same school','MAT-RLSB02');
insert into public.students(id,class_id,student_number,display_name,pin_code) values
 ('fc000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000001',1,'RLS pupil A','0123'),
 ('fc000000-0000-4000-8000-000000000002','fb000000-0000-4000-8000-000000000002',1,'RLS pupil B','4567');
select pg_temp.assert_true((select pin_code <> '0123' and pin_code=extensions.crypt('0123',pin_code) from public.students where id='fc000000-0000-4000-8000-000000000001'), 'PIN stored as bcrypt');
insert into public.game_results(student_id,class_id,student_name,game_key,score,total_questions,stars) values
 ('fc000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000001','RLS pupil A','training',3,3,3),
 ('fc000000-0000-4000-8000-000000000002','fb000000-0000-4000-8000-000000000002','RLS pupil B','bingo',4,4,4);

set local role authenticated;
select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"fa000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select pg_temp.assert_true((select count(*)=1 from public.classes where class_code in ('MAT-RLSA01','MAT-RLSB02')), 'teacher A sees only own class at same school');
select pg_temp.assert_true((select count(*)=1 from public.students where id in ('fc000000-0000-4000-8000-000000000001','fc000000-0000-4000-8000-000000000002')), 'teacher A sees only own pupils');
select pg_temp.assert_true((select count(*)=1 from public.game_results where class_id in ('fb000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000002')), 'teacher A sees only own results');
select pg_temp.assert_true((select count(*)=0 from public.profiles where id='fa000000-0000-4000-8000-000000000002'), 'teacher cannot read other profile');
select pg_temp.denied($s$select pin_code from public.students$s$, 'teacher cannot read PIN or hash');
select pg_temp.denied($s$update public.profiles set role='admin' where id=auth.uid()$s$, 'teacher cannot promote self');
select pg_temp.denied($s$update public.profiles set id='fa000000-0000-4000-8000-000000000002' where id=auth.uid()$s$, 'teacher cannot change profile ID');
select pg_temp.denied($s$insert into public.classes(teacher_id,class_name,school_name,class_code) values ('fa000000-0000-4000-8000-000000000002','Attack','Same school','MAT-ATTACK')$s$, 'cannot create class for other teacher');
select pg_temp.denied($s$insert into public.classes(teacher_id,class_name,school_name,class_code) values (auth.uid(),'Attack','Other school','MAT-ATTACK')$s$, 'class school must match profile');
select pg_temp.denied($s$insert into public.students(class_id,student_number,display_name,pin_code) values ('fb000000-0000-4000-8000-000000000002',2,'Attack','1234')$s$, 'cannot add pupil to other class');
select pg_temp.denied($s$update public.classes set teacher_id='fa000000-0000-4000-8000-000000000002' where teacher_id=auth.uid()$s$, 'cannot transfer class ownership');
select pg_temp.denied($s$update public.students set class_id='fb000000-0000-4000-8000-000000000002' where id='fc000000-0000-4000-8000-000000000001'$s$, 'cannot move pupil to other class');
select pg_temp.affected($s$update public.classes set class_name='Attack' where id='fb000000-0000-4000-8000-000000000002'$s$,0,'cannot update other class');
select pg_temp.affected($s$delete from public.classes where id='fb000000-0000-4000-8000-000000000002'$s$,0,'cannot delete other class');
select pg_temp.affected($s$update public.students set display_name='Attack' where id='fc000000-0000-4000-8000-000000000002'$s$,0,'cannot update other pupil');
select pg_temp.affected($s$delete from public.students where id='fc000000-0000-4000-8000-000000000002'$s$,0,'cannot delete other pupil');
select pg_temp.affected($s$delete from public.game_results where class_id='fb000000-0000-4000-8000-000000000002'$s$,0,'cannot delete other results');
select pg_temp.denied($s$insert into public.game_results(class_id,game_key) values ('fb000000-0000-4000-8000-000000000002','training')$s$, 'teacher cannot forge result');
with added as (insert into public.classes(teacher_id,class_name,school_name,class_code) values (auth.uid(),'RLS new','Same school','MAT-RLSNEW') returning id)
select pg_temp.assert_true(count(*)=1, 'own class creation with RETURNING works') from added;
with added as (insert into public.students(class_id,student_number,display_name,pin_code) values ('fb000000-0000-4000-8000-000000000001',2,'RLS new','9876') returning id,display_name)
select pg_temp.assert_true(count(*)=1, 'own pupil creation with RETURNING works') from added;
select pg_temp.affected($s$delete from public.students where class_id='fb000000-0000-4000-8000-000000000001' and student_number=2$s$,1,'own pupil deletion works');
select pg_temp.affected($s$delete from public.classes where class_code='MAT-RLSNEW'$s$,1,'own class deletion works');

select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"fa000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select pg_temp.assert_true((select count(*)=1 and bool_and(teacher_id=auth.uid()) from public.classes where class_code in ('MAT-RLSA01','MAT-RLSB02')), 'teacher B sees only own class');
select pg_temp.assert_true((select count(id)=0 from public.students where class_id='fb000000-0000-4000-8000-000000000001'), 'teacher B cannot read A pupils');
select pg_temp.assert_true((select count(*)=0 from public.game_results where class_id='fb000000-0000-4000-8000-000000000001'), 'teacher B cannot read A results');
select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"sub":"fa000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select pg_temp.assert_true((select count(*)=2 from public.classes where class_code in ('MAT-RLSA01','MAT-RLSB02')), 'admin sees both classes');
select pg_temp.assert_true((select count(id)=2 from public.students where id in ('fc000000-0000-4000-8000-000000000001','fc000000-0000-4000-8000-000000000002')), 'admin sees both pupil lists');
select pg_temp.assert_true((select count(*)=2 from public.game_results where class_id in ('fb000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000002')), 'admin sees both journals');

set local role anon;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"anon"}',true);
select pg_temp.denied('select id from public.profiles','anonymous profile read denied');
select pg_temp.denied('select id from public.classes','anonymous class enumeration denied');
select pg_temp.denied('select id from public.students','anonymous pupil enumeration denied');
select pg_temp.denied('select * from public.game_results','anonymous journal read denied');
select pg_temp.denied($s$insert into public.game_results(game_key) values ('training')$s$, 'anonymous direct result insert denied');
select pg_temp.denied('select * from math_private.student_sessions','private sessions inaccessible');
select pg_temp.assert_true((public.math_check_connection()->>'ok')::boolean, 'anonymous connection check works');
select pg_temp.assert_true((public.math_find_class('MAT-RLSA01')->'data'->>'id')='fb000000-0000-4000-8000-000000000001','class lookup needs exact code');
select pg_temp.assert_true(not (public.math_students_for_login('fb000000-0000-4000-8000-000000000001','WRONG')->>'ok')::boolean,'class ID alone cannot list pupils');
select pg_temp.assert_true((public.math_students_for_login('fb000000-0000-4000-8000-000000000001','MAT-RLSA01')->'data'->0->>'display_name')='RLS pupil A','class code roster works');
select pg_temp.assert_true(not ((public.math_students_for_login('fb000000-0000-4000-8000-000000000001','MAT-RLSA01')->'data'->0) ? 'pin_code'),'roster contains no PIN');
select pg_temp.assert_true((public.math_student_login('fc000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000001','MAT-RLSA01','9999')->>'reason')='invalid_pin','wrong PIN rejected');
insert into math_test_tokens values ('valid',public.math_student_login('fc000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000001','MAT-RLSA01','0123')->'data'->>'session_token');
select pg_temp.assert_true((select token ~ '^[a-f0-9]{64}$' from math_test_tokens where name='valid'),'valid PIN returns random session');
select pg_temp.assert_true((public.math_student_session((select token from math_test_tokens where name='valid'))->'data'->>'studentId')='fc000000-0000-4000-8000-000000000001','server determines student identity');
select pg_temp.assert_true(not (public.math_save_game_result(repeat('0',64),'training',1,1,1,1)->>'ok')::boolean,'forged session cannot write result');
select pg_temp.assert_true(not (public.math_save_game_result((select token from math_test_tokens where name='valid'),'training',5,1,1,1)->>'ok')::boolean,'invalid score rejected');
select pg_temp.assert_true((public.math_save_game_result((select token from math_test_tokens where name='valid'), game_key,1,1,1,2)->>'ok')::boolean,'student result writes: ' || game_key)
  from unnest(array['training','bingo','families','robot','treasure','secret_code','balloons']) game_key;
select public.math_student_logout((select token from math_test_tokens where name='valid'));
select pg_temp.assert_true(not (public.math_student_session((select token from math_test_tokens where name='valid'))->>'ok')::boolean,'logout revokes token');
select public.math_student_login('fc000000-0000-4000-8000-000000000002','fb000000-0000-4000-8000-000000000002','MAT-RLSB02','0000') from generate_series(1,5);
select pg_temp.assert_true((public.math_student_login('fc000000-0000-4000-8000-000000000002','fb000000-0000-4000-8000-000000000002','MAT-RLSB02','4567')->>'reason')='rate_limited','five wrong PINs lock even correct PIN temporarily');
insert into math_test_tokens values ('expired',public.math_student_login('fc000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000001','MAT-RLSA01','0123')->'data'->>'session_token');
reset role;
select pg_temp.assert_true((select count(*)=8 and bool_and(student_name='RLS pupil A') from public.game_results where student_id='fc000000-0000-4000-8000-000000000001' and class_id='fb000000-0000-4000-8000-000000000001'), 'all seven games bind to canonical pupil/class');
update math_private.student_sessions set expires_at=now()-interval '1 second' where student_id='fc000000-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.assert_true(not (public.math_save_game_result((select token from math_test_tokens where name='expired'),'training',1,1,1,1)->>'ok')::boolean,'expired session cannot write result');
insert into math_test_tokens values ('reset',public.math_student_login('fc000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000001','MAT-RLSA01','0123')->'data'->>'session_token');
reset role;
update public.students set pin_code='3210' where id='fc000000-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.assert_true(not (public.math_student_session((select token from math_test_tokens where name='reset'))->>'ok')::boolean,'PIN reset revokes previous sessions');
reset role;
select jsonb_build_object('passed',count(*),'failed',count(*) filter (where not passed),'tests',jsonb_agg(name)) as security_test_report from math_test_results;
