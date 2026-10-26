# Unique class PINs and teacher PIN changes

Status: prepared locally; not applied to the live database or published.

The existing 20260831 teacher-isolation migration is a prerequisite. The new
migration replaces only math_private.hash_student_pin and adds a private
per-class write lock. It preserves all existing students, PIN hashes and results,
including pre-existing duplicate PINs. Existing duplicates must be changed by
the teacher individually; no student should be deleted and recreated.

New and changed PINs must be four digits and unused by any other student in the
same class (including inactive students). Different classes may reuse a PIN.
Leading zeroes are retained. Successful changes revoke the student's previous
sessions and clear failed-login attempts using the existing trigger behavior.
PINs and their hashes remain unreadable by teachers and browser clients.

## Apply and publish

1. In Supabase SQL Editor review and run 20261025_unique_class_pins.sql. It is
   transactional and contains its own BEGIN/COMMIT. It does not change any
   existing application records.
2. Optionally run student-pin-tests.sql as a single script. Its synthetic
   fixtures and helper functions are enclosed in BEGIN/ROLLBACK and must never
   be committed. The existing teacher-isolation-tests.sql must likewise only
   run in an explicitly rolled-back transaction.
3. Publish index.html, style.css, db-service.js and teacher-panel.js together
   through the existing GitHub main / Netlify pipeline. Apply the SQL first,
   so even the previous browser version rejects duplicate PINs.
4. As the class owner open a test class, change one pupil's PIN, and confirm
   the old PIN fails while the new PIN logs in. Check the existing journal.
5. Try the same PIN for a different pupil in that class: both adding a pupil
   and changing a PIN must show the duplicate-PIN error. A different class may
   use it. Teachers must not be able to edit another teacher's students.

The panel exposes a Change PIN command; it never displays the old PIN. Cancel,
class changes, page navigation and logout clear the new PIN field. Responses
from an earlier form cannot replace a newly selected student or class.

## Verification

Run the JavaScript suite with `node --test tests/*.test.cjs`.
The SQL scripts were also exercised on local PostgreSQL via PGlite with
pgcrypto and real anon/authenticated roles: 58 existing isolation assertions
and 20 PIN assertions passed. A separate fixture verified that applying the
migration twice preserves the exact IDs and hashes of pre-existing duplicate
PINs. PGlite is single-connection; this does not claim a multi-connection
concurrency test. The lock row serializes PIN writes and forces a transaction
retry if a concurrent writer has changed its snapshot.
