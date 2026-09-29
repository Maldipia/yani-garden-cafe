-- Approved OT / night-differential hours are snapshots taken when the owner
-- approved them. If a time is corrected afterwards (e.g. a manual 12:12 AM
-- time-out reset to 10:00 PM), the old approval must not keep paying hours the
-- corrected times no longer support. Paid hours = LEAST(approved, actual).

CREATE OR REPLACE FUNCTION public.hr_night_hours(p_staff_id uuid, p_date date)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH ev AS (SELECT t.event_type, t.event_time FROM hr_time_logs t
              WHERE t.staff_id=p_staff_id AND t.log_date=p_date),
  starts AS (SELECT event_time st FROM ev WHERE event_type IN ('CLOCK_IN','BREAK_END','BROKEN_TIME_END')),
  spans AS (SELECT s2.st, (SELECT min(e.event_time) FROM ev e
             WHERE e.event_type IN ('CLOCK_OUT','BREAK_START','BROKEN_TIME_START')
               AND e.event_time > s2.st) en FROM starts s2)
  SELECT ROUND(COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
           LEAST(en, ((p_date+1) + TIME '06:00') AT TIME ZONE 'Asia/Manila')
         - GREATEST(st, (p_date + TIME '22:00') AT TIME ZONE 'Asia/Manila')))/3600.0)),0)::numeric, 2)
  FROM spans WHERE en IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.hr_night_hours(uuid,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_night_hours(uuid,date) TO service_role;

DO $mig$
DECLARE src text; n text;
BEGIN
  -- hr_compute_payroll: cap per-day approved OT / ND at actual
  src := pg_get_functiondef('public.hr_compute_payroll(uuid,text)'::regprocedure);
  n := replace(src, 'v_ot_d := COALESCE(v_ot_d,0);',
                    'v_ot_d := LEAST(COALESCE(v_ot_d,0), COALESCE(h.overtime_hours,0));');
  n := replace(n,   'v_nd_d := COALESCE(v_nd_d,0);',
                    'v_nd_d := LEAST(COALESCE(v_nd_d,0), hr_night_hours(s.id, d));');
  IF n = src OR position('hr_night_hours(s.id, d)' IN n) = 0 OR position('LEAST(COALESCE(v_ot_d,0)' IN n) = 0 THEN
    RAISE EXCEPTION 'hr_compute_payroll patch did not apply';
  END IF;
  EXECUTE n;

  -- hr_payroll_daily: show the same capped paid hours on the breakdown
  src := pg_get_functiondef('public.hr_payroll_daily(uuid,uuid)'::regprocedure);
  n := replace(src, 'IF ot_status <> ''APPROVED'' THEN ot_paid_hours := 0; END IF;',
                    'IF ot_status <> ''APPROVED'' THEN ot_paid_hours := 0; END IF;
        ot_paid_hours := LEAST(ot_paid_hours, ot_hours);');
  n := replace(n,   'IF nd_status <> ''APPROVED'' THEN nd_paid_hours := 0; END IF;',
                    'IF nd_status <> ''APPROVED'' THEN nd_paid_hours := 0; END IF;
        nd_paid_hours := LEAST(nd_paid_hours, night_hours);');
  IF position('LEAST(ot_paid_hours, ot_hours)' IN n) = 0 OR position('LEAST(nd_paid_hours, night_hours)' IN n) = 0 THEN
    RAISE EXCEPTION 'hr_payroll_daily patch did not apply';
  END IF;
  EXECUTE n;
END $mig$;
