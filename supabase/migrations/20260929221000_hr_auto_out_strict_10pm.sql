-- Owner policy (2026-09-29, revised): a past shift with no time-out ends at
-- exactly 10:00 PM on its shift date (taps after 10 PM do not extend it), and
-- every manually entered time-out in September is set to 10:00 PM.
-- PENDING: not yet applied — Supabase connection needs re-authorisation.
-- (hr_daily_hours body: same as 20260929215000 with
--   v_assumed := (p_date + TIME '22:00') AT TIME ZONE 'Asia/Manila';
--  i.e. no GREATEST(..., v_last).)

UPDATE hr_time_logs t
   SET event_time = (t.log_date + TIME '22:00') AT TIME ZONE 'Asia/Manila',
       notes = COALESCE(t.notes,'') || ' | set to 10:00 PM by owner policy 2026-09-29 (was '
               || to_char(t.event_time AT TIME ZONE 'Asia/Manila','MM-DD HH12:MI AM') || ')'
 FROM hr_staff_master m
 WHERE m.id = t.staff_id AND m.staff_code <> 'USR_001'
   AND t.attendance_source = 'MANUAL' AND t.event_type = 'CLOCK_OUT'
   AND t.log_date >= '2026-09-01'
   AND t.event_time <> (t.log_date + TIME '22:00') AT TIME ZONE 'Asia/Manila';
