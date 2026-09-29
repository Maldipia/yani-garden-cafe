-- Pay rates by effective date. hr_compensation_history existed but nothing
-- wrote to or read from it, so payroll only ever saw the single rate on the
-- profile. Now every rate change is a row (staff, effective date, rate) and
-- payroll uses the rate in force ON EACH WORK DATE, so a change in the middle
-- of a cut-off (Gerald: ₱500 to Sep 15, ₱600 from Sep 16) just works. The
-- profile rate is kept equal to the latest row that is already in effect.

ALTER TABLE public.hr_compensation_history ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_comp_history_staff_date
  ON public.hr_compensation_history (staff_id, effective_date);

-- 1. The rate in force for one staff member on one date.
--    basic_rate is in the pay_basis unit (DAILY → per day, HOURLY → per hour,
--    MONTHLY → per month). Falls back to the earliest row for dates before the
--    first row, and to the profile when there is no history at all.
CREATE OR REPLACE FUNCTION public.hr_rate_on(p_staff_id uuid, p_date date)
RETURNS TABLE(pay_basis text, basic_rate numeric, hourly numeric, effective_date date, source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE h record; m record; v_std numeric;
BEGIN
  SELECT COALESCE(sm.standard_hours_per_day,8) AS std, sm.pay_basis AS pb, sm.daily_rate AS dr, sm.hourly_rate AS hr, sm.monthly_rate AS mr
    INTO m FROM hr_staff_master sm WHERE sm.id = p_staff_id;
  v_std := COALESCE(m.std, 8);

  SELECT c.pay_basis AS pb, c.basic_rate AS br, c.hourly_rate AS hr, c.effective_date AS ed INTO h
    FROM hr_compensation_history c
   WHERE c.staff_id = p_staff_id AND c.effective_date <= p_date
   ORDER BY c.effective_date DESC, c.created_at DESC LIMIT 1;
  IF h.br IS NULL THEN
    SELECT c.pay_basis AS pb, c.basic_rate AS br, c.hourly_rate AS hr, c.effective_date AS ed INTO h
      FROM hr_compensation_history c
     WHERE c.staff_id = p_staff_id
     ORDER BY c.effective_date ASC, c.created_at ASC LIMIT 1;
  END IF;

  IF h.br IS NOT NULL THEN
    pay_basis := COALESCE(h.pb,'DAILY'); basic_rate := h.br;
    effective_date := h.ed; source := 'HISTORY';
  ELSE
    pay_basis := COALESCE(m.pb,'DAILY');
    basic_rate := CASE pay_basis WHEN 'HOURLY' THEN m.hr WHEN 'MONTHLY' THEN m.mr ELSE m.dr END;
    effective_date := NULL; source := 'PROFILE';
  END IF;
  hourly := CASE pay_basis
              WHEN 'HOURLY'  THEN COALESCE(basic_rate,0)
              WHEN 'MONTHLY' THEN (COALESCE(basic_rate,0)*12)/(52*6*v_std)
              ELSE COALESCE(basic_rate,0)/NULLIF(v_std,0) END;
  hourly := COALESCE(hourly,0);
  RETURN NEXT;
END $$;

-- 2. Daily breakdown: the rate is looked up per day, and day pay is the sum of
--    the rounded components so the table always adds up to the header.
DROP FUNCTION IF EXISTS public.hr_payroll_daily(uuid, uuid);
CREATE FUNCTION public.hr_payroll_daily(p_cutoff_id uuid, p_staff_id uuid)
 RETURNS TABLE(work_date date, clock_in text, break_start text, break_end text, clock_out text, break_mins numeric, break_count integer, break_detail text, worked_hours numeric, regular_hours numeric, ot_hours numeric, ot_paid_hours numeric, ot_status text, undertime_hours numeric, standard_hours numeric, night_hours numeric, night_window text, hourly_rate numeric, day_pay numeric, night_diff_suggested numeric, sources text, is_holiday boolean, holiday_name text, art82_exempt boolean, nd_paid_hours numeric, nd_status text, in_manual boolean, out_manual boolean, break_manual boolean, manual_note text, rate_basic numeric, rate_basis text, rate_effective date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record; s record; d date; h record; v_hourly numeric; v_std numeric; rt record;
        n_start timestamptz; n_end timestamptz; v_exempt boolean; v_out timestamptz; v_last record;
BEGIN
  SELECT * INTO c FROM hr_payroll_cut_offs WHERE id=p_cutoff_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Cutoff not found'; END IF;
  SELECT m.*, COALESCE(m.standard_hours_per_day,8) AS std INTO s
  FROM hr_staff_master m WHERE m.id=p_staff_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Staff not found'; END IF;

  v_std := COALESCE(s.standard_hours_per_day,8);
  v_exempt := COALESCE(s.art82_exempt,false);

  d := c.start_date;
  WHILE d <= c.end_date LOOP
    SELECT * INTO h FROM hr_daily_hours(c.tenant_id,p_staff_id,d);
    IF COALESCE(h.worked_hours,0) > 0 OR EXISTS (
         SELECT 1 FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d) THEN
      work_date := d; art82_exempt := v_exempt;
      SELECT * INTO rt FROM hr_rate_on(p_staff_id, d);
      v_hourly := COALESCE(rt.hourly,0);
      rate_basic := rt.basic_rate; rate_basis := rt.pay_basis; rate_effective := rt.effective_date;

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

      SELECT (SELECT t.attendance_source='MANUAL' FROM hr_time_logs t
               WHERE t.staff_id=p_staff_id AND t.log_date=d AND t.event_type='CLOCK_IN'
               ORDER BY t.event_time, t.created_at LIMIT 1),
             (v_last.event_type='CLOCK_OUT' AND EXISTS (
               SELECT 1 FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d
                 AND t.event_type='CLOCK_OUT' AND t.event_time=v_last.event_time AND t.attendance_source='MANUAL')),
             EXISTS (SELECT 1 FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d
                       AND t.event_type IN ('BREAK_START','BREAK_END','BROKEN_TIME_START','BROKEN_TIME_END')
                       AND t.attendance_source='MANUAL'),
             (SELECT string_agg(replace(t.event_type,'_',' ')||' '||to_char(t.event_time AT TIME ZONE 'Asia/Manila','HH12:MI AM')
                                ||COALESCE(' — '||t.notes,''), '; ' ORDER BY t.event_time)
                FROM hr_time_logs t WHERE t.staff_id=p_staff_id AND t.log_date=d AND t.attendance_source='MANUAL')
        INTO in_manual, out_manual, break_manual, manual_note;
      in_manual := COALESCE(in_manual,false); out_manual := COALESCE(out_manual,false);
      break_manual := COALESCE(break_manual,false);

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

      IF v_exempt THEN
        nd_paid_hours := 0; nd_status := 'ART82_EXEMPT';
      ELSE
        SELECT COALESCE(n.approved_hours,0), COALESCE(n.status,'UNREVIEWED')
          INTO nd_paid_hours, nd_status
        FROM hr_night_diff_requests n
        WHERE n.staff_id=p_staff_id AND n.work_date=d;
        nd_paid_hours := COALESCE(nd_paid_hours,0);
        nd_status := COALESCE(nd_status, CASE WHEN night_hours>0 THEN 'UNREVIEWED' ELSE NULL END);
        IF nd_status <> 'APPROVED' THEN nd_paid_hours := 0; END IF;
      END IF;

      undertime_hours := CASE WHEN ot_hours>0 THEN 0 ELSE GREATEST(v_std-regular_hours,0) END;
      hourly_rate := ROUND(v_hourly,4);
      day_pay := ROUND(regular_hours*v_hourly,2) + ROUND(ot_paid_hours*v_hourly*1.25,2) + ROUND(nd_paid_hours*v_hourly*0.10,2);
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

-- 3. Cut-off totals: accumulate per day at that day's rate. regular_pay,
--    overtime_pay and night_diff_pay are sums of the per-day rounded amounts,
--    so they equal the daily table exactly. hourly_rate/daily_rate stored on
--    the row are the rate in force on the cut-off's last day; a change inside
--    the cut-off is spelled out in notes.
CREATE OR REPLACE FUNCTION public.hr_compute_payroll(p_cutoff_id uuid, p_actor text DEFAULT NULL::text)
 RETURNS TABLE(out_staff_code text, out_full_name text, out_days integer, out_regular_hours numeric, out_ot_hours numeric, out_gross numeric, out_deductions numeric, out_net numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c record; s record; d date; h record; ex record; rt record;
  v_reg numeric; v_ot_actual numeric; v_ot_paid numeric; v_days int; v_ut numeric; v_std numeric;
  v_hourly numeric; v_basic numeric; v_gross numeric; v_ded numeric;
  v_manual numeric; v_govt numeric; v_13 numeric; v_elig boolean;
  v_nd_hours numeric; v_nd_pay numeric; v_reg_pay numeric; v_ot_pay numeric;
  v_ot_d numeric; v_nd_d numeric; v_prev_rate numeric; v_rate_note text;
  v_end_rate record;
BEGIN
  SELECT * INTO c FROM hr_payroll_cut_offs WHERE id=p_cutoff_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Cutoff not found'; END IF;
  IF COALESCE(c.payroll_status,'OPEN') IN ('FINALIZED','PAID') THEN
    RAISE EXCEPTION 'Cutoff is % — reopen it before recomputing', c.payroll_status;
  END IF;

  FOR s IN
    SELECT m.id, m.staff_code AS code, m.full_name AS name, m.employment_type, m.role,
           m.pay_basis, COALESCE(m.standard_hours_per_day,8) std,
           COALESCE(m.art82_exempt,false) exempt
    FROM hr_staff_master m
    WHERE m.tenant_id=c.tenant_id AND m.employment_status='ACTIVE'
  LOOP
    v_reg:=0; v_ot_actual:=0; v_days:=0; v_ut:=0; v_std:=s.std;
    v_reg_pay:=0; v_ot_pay:=0; v_ot_paid:=0; v_nd_hours:=0; v_nd_pay:=0;
    v_prev_rate := NULL; v_rate_note := '';
    d := c.start_date;
    WHILE d <= c.end_date LOOP
      SELECT * INTO h FROM hr_daily_hours(c.tenant_id,s.id,d);
      IF COALESCE(h.worked_hours,0) > 0 THEN
        SELECT * INTO rt FROM hr_rate_on(s.id, d);
        v_hourly := COALESCE(rt.hourly,0);
        IF v_prev_rate IS NOT NULL AND v_hourly <> v_prev_rate THEN
          v_rate_note := v_rate_note || ' | rate ' || to_char(v_prev_rate,'FM999990.00') || '/h → ' ||
                         to_char(v_hourly,'FM999990.00') || '/h from ' || d;
        END IF;
        v_prev_rate := v_hourly;

        v_days:=v_days+1; v_reg:=v_reg+COALESCE(h.regular_hours,0);
        v_reg_pay := v_reg_pay + ROUND(COALESCE(h.regular_hours,0)*v_hourly, 2);
        v_ot_actual:=v_ot_actual+COALESCE(h.overtime_hours,0);
        IF COALESCE(h.overtime_hours,0)=0 THEN v_ut:=v_ut+GREATEST(v_std-COALESCE(h.regular_hours,0),0); END IF;

        IF NOT s.exempt THEN
          SELECT COALESCE(o.actual_hours,0) INTO v_ot_d FROM hr_overtime_requests o
           WHERE o.staff_id=s.id AND o.work_date=d AND o.status='APPROVED';
          v_ot_d := COALESCE(v_ot_d,0);
          v_ot_paid := v_ot_paid + v_ot_d;
          v_ot_pay  := v_ot_pay + ROUND(v_ot_d*v_hourly*1.25, 2);

          SELECT COALESCE(n.approved_hours,0) INTO v_nd_d FROM hr_night_diff_requests n
           WHERE n.staff_id=s.id AND n.work_date=d AND n.status='APPROVED';
          v_nd_d := COALESCE(v_nd_d,0);
          v_nd_hours := v_nd_hours + v_nd_d;
          v_nd_pay   := v_nd_pay + ROUND(v_nd_d*v_hourly*0.10, 2);
        END IF;
      END IF;
      d:=d+1;
    END LOOP;
    CONTINUE WHEN v_days=0;

    SELECT * INTO v_end_rate FROM hr_rate_on(s.id, c.end_date);
    v_hourly := COALESCE(v_end_rate.hourly,0);
    v_basic := ROUND(v_reg_pay + v_ot_pay, 2);

    SELECT COALESCE(holiday_pay,0) hp, COALESCE(rest_day_pay,0) rp,
           COALESCE(allowances,0) al, COALESCE(incentives,0) inc, COALESCE(tips_share,0) tp,
           COALESCE(government_deduction,0) gd INTO ex
    FROM hr_payroll_details WHERE cutoff_id=p_cutoff_id AND staff_id=s.id;

    v_manual := COALESCE(ex.hp,0)+COALESCE(ex.rp,0)
              + COALESCE(ex.al,0)+COALESCE(ex.inc,0)+COALESCE(ex.tp,0);
    v_govt := COALESCE(ex.gd,0);
    v_gross := ROUND(v_basic + v_nd_pay + v_manual, 2);

    SELECT COALESCE(SUM(COALESCE(x.amount_deducted,x.amount)),0) INTO v_ded
    FROM hr_deductions x WHERE x.staff_id=s.id AND x.cutoff_id=p_cutoff_id
      AND COALESCE(x.status,'APPROVED') IN ('APPROVED','APPLIED');

    v_elig := (COALESCE(s.employment_type,'')='REGULAR') AND (COALESCE(s.role,'')<>'TRAINEE');
    v_13 := CASE WHEN v_elig THEN ROUND(v_basic/12.0,2) ELSE 0 END;

    INSERT INTO hr_payroll_details (
      tenant_id,cutoff_id,staff_id,employment_type,pay_basis,
      hourly_rate,daily_rate,monthly_rate,approved_regular_hours,
      actual_ot_hours,approved_ot_hours,undertime_minutes,
      regular_pay,overtime_pay,night_diff_hours,night_diff_pay,
      gross_pay,thirteenth_month_accrual,government_deduction,
      other_deduction,total_deductions,net_pay,payroll_status,notes)
    VALUES (
      c.tenant_id,p_cutoff_id,s.id,s.employment_type,COALESCE(v_end_rate.pay_basis,s.pay_basis),
      ROUND(v_hourly,4),
      CASE WHEN COALESCE(v_end_rate.pay_basis,'DAILY')='DAILY' THEN v_end_rate.basic_rate ELSE NULL END,
      CASE WHEN v_end_rate.pay_basis='MONTHLY' THEN v_end_rate.basic_rate ELSE NULL END,
      v_reg,v_ot_actual,v_ot_paid,ROUND(v_ut*60),
      ROUND(v_reg_pay,2),ROUND(v_ot_pay,2),v_nd_hours,ROUND(v_nd_pay,2),
      v_gross,v_13,v_govt,
      v_ded,ROUND(v_ded+v_govt,2),ROUND(v_gross-v_ded-v_govt,2),'DRAFT',
      'Computed '||to_char(now() AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI')||
      ' from '||v_days||' day(s)'||COALESCE(' by '||p_actor,'')||
      CASE WHEN s.exempt THEN ' | Art.82 exempt — no OT / night differential entitlement' ELSE '' END ||
      v_rate_note)
    ON CONFLICT (cutoff_id,staff_id) DO UPDATE SET
      pay_basis=EXCLUDED.pay_basis, daily_rate=EXCLUDED.daily_rate, monthly_rate=EXCLUDED.monthly_rate,
      approved_regular_hours=EXCLUDED.approved_regular_hours,
      actual_ot_hours=EXCLUDED.actual_ot_hours, approved_ot_hours=EXCLUDED.approved_ot_hours,
      undertime_minutes=EXCLUDED.undertime_minutes, hourly_rate=EXCLUDED.hourly_rate,
      regular_pay=EXCLUDED.regular_pay, overtime_pay=EXCLUDED.overtime_pay,
      night_diff_hours=EXCLUDED.night_diff_hours, night_diff_pay=EXCLUDED.night_diff_pay,
      gross_pay=EXCLUDED.gross_pay, thirteenth_month_accrual=EXCLUDED.thirteenth_month_accrual,
      other_deduction=EXCLUDED.other_deduction, total_deductions=EXCLUDED.total_deductions,
      net_pay=EXCLUDED.net_pay, notes=EXCLUDED.notes, updated_at=now();

    out_staff_code:=s.code; out_full_name:=s.name; out_days:=v_days;
    out_regular_hours:=v_reg; out_ot_hours:=v_ot_paid;
    out_gross:=v_gross; out_deductions:=ROUND(v_ded+v_govt,2); out_net:=ROUND(v_gross-v_ded-v_govt,2);
    RETURN NEXT;
  END LOOP;
END $function$;

-- 4. Seed history from the profile for every active staff member who has a
--    rate and no history yet, so every future change is a delta on a record.
INSERT INTO public.hr_compensation_history
  (tenant_id, staff_id, effective_date, pay_basis, basic_rate, hourly_rate, reason_for_change)
SELECT m.tenant_id, m.id, COALESCE(m.date_hired, DATE '2026-01-01'), COALESCE(m.pay_basis,'DAILY'),
       CASE COALESCE(m.pay_basis,'DAILY') WHEN 'HOURLY' THEN m.hourly_rate WHEN 'MONTHLY' THEN m.monthly_rate ELSE m.daily_rate END,
       CASE WHEN COALESCE(m.pay_basis,'DAILY')='HOURLY' THEN m.hourly_rate ELSE NULL END,
       'Seeded from profile rate (2026-09-29)'
  FROM hr_staff_master m
 WHERE m.employment_status='ACTIVE'
   AND (CASE COALESCE(m.pay_basis,'DAILY') WHEN 'HOURLY' THEN m.hourly_rate WHEN 'MONTHLY' THEN m.monthly_rate ELSE m.daily_rate END) IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM hr_compensation_history h WHERE h.staff_id=m.id);

-- Gerald (USR_014): ₱500/day from Sep 3, ₱600/day from Sep 16 (owner, 2026-09-29).
DELETE FROM public.hr_compensation_history
 WHERE staff_id=(SELECT id FROM hr_staff_master WHERE staff_code='USR_014')
   AND reason_for_change='Seeded from profile rate (2026-09-29)';
INSERT INTO public.hr_compensation_history (tenant_id, staff_id, effective_date, pay_basis, basic_rate, reason_for_change)
SELECT m.tenant_id, m.id, v.d, 'DAILY', v.r, v.why
  FROM hr_staff_master m,
       (VALUES (DATE '2026-09-03', 500::numeric, 'Training rate — owner, 2026-09-29'),
               (DATE '2026-09-16', 600::numeric, 'Rate increase — owner, 2026-09-29')) AS v(d, r, why)
 WHERE m.staff_code='USR_014'
ON CONFLICT (staff_id, effective_date) DO UPDATE SET basic_rate=EXCLUDED.basic_rate, pay_basis=EXCLUDED.pay_basis, reason_for_change=EXCLUDED.reason_for_change;

REVOKE ALL ON FUNCTION public.hr_rate_on(uuid,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_rate_on(uuid,date) TO service_role;
