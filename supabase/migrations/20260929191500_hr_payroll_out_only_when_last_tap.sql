-- OUT column: only the day's FINAL tap counts as the time-out. A stray midday
-- clock-out followed by clock-in / breaks used to be shown as "OUT 12:44 PM"
-- on a shift that was still open — which is exactly the kind of row that
-- hides a missing time-out. The hours themselves were never affected.

CREATE OR REPLACE FUNCTION public.hr_payroll_daily(p_cutoff_id uuid, p_staff_id uuid)
 RETURNS TABLE(work_date date, clock_in text, break_start text, break_end text, clock_out text, break_mins numeric, break_count integer, break_detail text, worked_hours numeric, regular_hours numeric, ot_hours numeric, ot_paid_hours numeric, ot_status text, undertime_hours numeric, standard_hours numeric, night_hours numeric, night_window text, hourly_rate numeric, day_pay numeric, night_diff_suggested numeric, sources text, is_holiday boolean, holiday_name text, art82_exempt boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record; s record; d date; h record; v_hourly numeric; v_std numeric;
        n_start timestamptz; n_end timestamptz; v_exempt boolean; v_out timestamptz; v_last record;
BEGIN
  SELECT * INTO c FROM hr_payroll_cut_offs WHERE id=p_cutoff_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Cutoff not found'; END IF;
  SELECT m.*, COALESCE(m.standard_hours_per_day,8) AS std INTO s
  FROM hr_staff_master m WHERE m.id=p_staff_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Staff not found'; END IF;

  v_std := COALESCE(s.standard_hours_per_day,8);
  v_exempt := COALESCE(s.art82_exempt,false);
  v_hourly := CASE WHEN s.pay_basis='HOURLY' THEN COALESCE(s.hourly_rate,0)
                   WHEN s.pay_basis='MONTHLY' THEN (COALESCE(s.monthly_rate,0)*12)/(52*6*v_std)
                   ELSE COALESCE(s.daily_rate,0)/NULLIF(v_std,0) END;

  d := c.start_date;
  WHILE d <= c.end_date LOOP
    SELECT * INTO h FROM hr_daily_hours(c.tenant_id,p_staff_id,d);
    IF COALESCE(h.worked_hours,0) > 0 OR EXISTS (
         SELECT 1 FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d) THEN
      work_date := d; art82_exempt := v_exempt;
      SELECT to_char(min(t.event_time) AT TIME ZONE 'Asia/Manila','HH12:MI AM') INTO clock_in
        FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d AND t.event_type='CLOCK_IN';
      SELECT t.event_type, t.event_time INTO v_last
        FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d
        ORDER BY t.event_time DESC, t.created_at DESC LIMIT 1;
      v_out := CASE WHEN v_last.event_type='CLOCK_OUT' THEN v_last.event_time END;
      clock_out := CASE WHEN v_out IS NULL THEN NULL
                        ELSE to_char(v_out AT TIME ZONE 'Asia/Manila','HH12:MI AM')
                             || CASE WHEN (v_out AT TIME ZONE 'Asia/Manila')::date > d THEN ' +1' ELSE '' END END;
      SELECT string_agg(DISTINCT t.attendance_source,'/') INTO sources
        FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d;

      WITH ev AS (SELECT t.event_type,t.event_time FROM hr_time_logs t
                  WHERE t.staff_id=p_staff_id AND t.log_date=d
                    AND t.event_type IN ('BREAK_START','BREAK_END')),
      pairs AS (SELECT a.event_time bs,
                (SELECT min(b.event_time) FROM ev b WHERE b.event_type='BREAK_END' AND b.event_time>a.event_time) be
                FROM ev a WHERE a.event_type='BREAK_START')
      SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (be-bs))/60),0)::numeric,
             COUNT(*) FILTER (WHERE be IS NOT NULL),
             string_agg(to_char(bs AT TIME ZONE 'Asia/Manila','HH12:MI')||'-'||
                        to_char(be AT TIME ZONE 'Asia/Manila','HH12:MI'),', ' ORDER BY bs)
        INTO break_mins, break_count, break_detail
      FROM pairs WHERE be IS NOT NULL;

      SELECT to_char(min(t.event_time) AT TIME ZONE 'Asia/Manila','HH12:MI AM') INTO break_start
        FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d AND t.event_type='BREAK_START';
      SELECT to_char(max(t.event_time) AT TIME ZONE 'Asia/Manila','HH12:MI AM') INTO break_end
        FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d AND t.event_type='BREAK_END';

      n_start := (d + TIME '22:00') AT TIME ZONE 'Asia/Manila';
      n_end   := ((d+1) + TIME '06:00') AT TIME ZONE 'Asia/Manila';
      WITH ev AS (SELECT t.event_type,t.event_time FROM hr_time_logs t
                  WHERE t.staff_id=p_staff_id AND t.log_date=d),
      starts AS (SELECT event_time st FROM ev WHERE event_type IN ('CLOCK_IN','BREAK_END','BROKEN_TIME_END')),
      spans AS (SELECT s2.st,(SELECT min(e.event_time) FROM ev e
                 WHERE e.event_type IN ('CLOCK_OUT','BREAK_START','BROKEN_TIME_START')
                   AND e.event_time>s2.st) en FROM starts s2)
      SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(en,n_end)-GREATEST(st,n_start)))/3600.0)),0)::numeric
        INTO night_hours FROM spans WHERE en IS NOT NULL;
      night_hours := ROUND(COALESCE(night_hours,0),2);
      night_window := CASE WHEN night_hours>0 THEN '10:00 PM - 6:00 AM' ELSE NULL END;

      worked_hours:=COALESCE(h.worked_hours,0); regular_hours:=COALESCE(h.regular_hours,0);
      ot_hours:=COALESCE(h.overtime_hours,0); standard_hours:=v_std;

      -- approved OT for THIS day
      IF v_exempt THEN
        ot_paid_hours := 0; ot_status := 'ART82_EXEMPT';
      ELSE
        SELECT COALESCE(o.actual_hours,0), COALESCE(o.status,'UNREVIEWED')
          INTO ot_paid_hours, ot_status
        FROM hr_overtime_requests o
        WHERE o.staff_id=p_staff_id AND o.work_date=d;
        ot_paid_hours := COALESCE(ot_paid_hours,0);
        ot_status := COALESCE(ot_status, CASE WHEN ot_hours>0 THEN 'UNREVIEWED' ELSE NULL END);
        IF ot_status <> 'APPROVED' THEN ot_paid_hours := 0; END IF;
      END IF;

      undertime_hours := CASE WHEN ot_hours>0 THEN 0 ELSE GREATEST(v_std-regular_hours,0) END;
      hourly_rate := ROUND(v_hourly,4);
      day_pay := ROUND(regular_hours*v_hourly + ot_paid_hours*v_hourly*1.25, 2);
      night_diff_suggested := CASE WHEN v_exempt THEN 0
                                   ELSE ROUND(night_hours*v_hourly*0.10,2) END;

      SELECT true, hc.holiday_name INTO is_holiday, holiday_name
        FROM hr_holiday_calendar hc WHERE hc.holiday_date=d LIMIT 1;
      is_holiday := COALESCE(is_holiday,false);
      RETURN NEXT;
    END IF;
    d := d+1;
  END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION public.hr_daily_summary(p_staff_id uuid, p_from date, p_to date)
 RETURNS TABLE(work_date date, first_in text, last_out text, break_detail text, break_mins numeric, break_count integer, worked_hours numeric, regular_hours numeric, ot_hours numeric, undertime_hours numeric, standard_hours numeric, night_hours numeric, is_open boolean, sources text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE tid uuid; v_std numeric; d date; h record; n_start timestamptz; n_end timestamptz; v_out timestamptz; v_last record;
BEGIN
  SELECT tenant_id, COALESCE(standard_hours_per_day,8) INTO tid, v_std
  FROM hr_staff_master WHERE id = p_staff_id;
  IF tid IS NULL THEN RETURN; END IF;

  d := p_from;
  WHILE d <= p_to LOOP
    IF EXISTS (SELECT 1 FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d) THEN
      SELECT * INTO h FROM hr_daily_hours(tid, p_staff_id, d);
      work_date := d; standard_hours := v_std;

      SELECT to_char(min(t.event_time) AT TIME ZONE 'Asia/Manila','HH12:MI AM') INTO first_in
        FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d AND t.event_type='CLOCK_IN';
      SELECT t.event_type, t.event_time INTO v_last
        FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d
        ORDER BY t.event_time DESC, t.created_at DESC LIMIT 1;
      v_out := CASE WHEN v_last.event_type='CLOCK_OUT' THEN v_last.event_time END;
      last_out := CASE WHEN v_out IS NULL THEN NULL
                       ELSE to_char(v_out AT TIME ZONE 'Asia/Manila','HH12:MI AM')
                            || CASE WHEN (v_out AT TIME ZONE 'Asia/Manila')::date > d THEN ' +1' ELSE '' END END;
      SELECT string_agg(DISTINCT t.attendance_source,'/') INTO sources
        FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d;

      WITH ev AS (SELECT t.event_type,t.event_time FROM hr_time_logs t
                  WHERE t.staff_id=p_staff_id AND t.log_date=d
                    AND t.event_type IN ('BREAK_START','BREAK_END')),
      pairs AS (SELECT a.event_time bs,
                (SELECT min(b.event_time) FROM ev b
                  WHERE b.event_type='BREAK_END' AND b.event_time>a.event_time) be
                FROM ev a WHERE a.event_type='BREAK_START')
      SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (be-bs))/60),0)::numeric,
             COUNT(*) FILTER (WHERE be IS NOT NULL),
             string_agg(to_char(bs AT TIME ZONE 'Asia/Manila','HH12:MI AM')||'–'||
                        to_char(be AT TIME ZONE 'Asia/Manila','HH12:MI AM'), ', ' ORDER BY bs)
        INTO break_mins, break_count, break_detail
      FROM pairs WHERE be IS NOT NULL;

      n_start := (d + TIME '22:00') AT TIME ZONE 'Asia/Manila';
      n_end   := ((d+1) + TIME '06:00') AT TIME ZONE 'Asia/Manila';
      WITH ev AS (SELECT t.event_type,t.event_time FROM hr_time_logs t
                  WHERE t.staff_id=p_staff_id AND t.log_date=d),
      starts AS (SELECT event_time st FROM ev WHERE event_type IN ('CLOCK_IN','BREAK_END','BROKEN_TIME_END')),
      spans AS (SELECT s2.st,(SELECT min(e.event_time) FROM ev e
                 WHERE e.event_type IN ('CLOCK_OUT','BREAK_START','BROKEN_TIME_START')
                   AND e.event_time>s2.st) en FROM starts s2)
      SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (LEAST(en,n_end)-GREATEST(st,n_start)))/3600.0)),0)::numeric
        INTO night_hours FROM spans WHERE en IS NOT NULL;

      worked_hours:=COALESCE(h.worked_hours,0); regular_hours:=COALESCE(h.regular_hours,0);
      ot_hours:=COALESCE(h.overtime_hours,0);
      undertime_hours := CASE WHEN ot_hours>0 THEN 0 ELSE GREATEST(v_std-regular_hours,0) END;
      night_hours := ROUND(COALESCE(night_hours,0),2);
      is_open := COALESCE(h.is_open,false);
      RETURN NEXT;
    END IF;
    d := d + 1;
  END LOOP;
END $function$;
