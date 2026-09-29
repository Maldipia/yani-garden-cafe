-- Night differential is paid the same way overtime is: computed from attendance,
-- shown as "worked but not approved", and included in pay only once the owner
-- approves it for the cut-off. Per-day decisions live in hr_night_diff_requests,
-- mirroring hr_overtime_requests. The old path (type the amount under
-- "premiums") is retired: night_diff_pay is now always derived from approvals.

CREATE TABLE IF NOT EXISTS public.hr_night_diff_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES hr_tenants(id),
  staff_id       uuid NOT NULL REFERENCES hr_staff_master(id),
  work_date      date NOT NULL,
  night_hours    numeric NOT NULL DEFAULT 0,   -- hours inside 10:00 PM–6:00 AM at decision time
  approved_hours numeric NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (staff_id, work_date)
);
ALTER TABLE public.hr_night_diff_requests ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS ix_hr_nd_staff_date ON public.hr_night_diff_requests (staff_id, work_date);

-- hr_payroll_daily gains nd_paid_hours / nd_status and folds approved ND into day_pay.
DROP FUNCTION IF EXISTS public.hr_payroll_daily(uuid, uuid);
CREATE FUNCTION public.hr_payroll_daily(p_cutoff_id uuid, p_staff_id uuid)
 RETURNS TABLE(work_date date, clock_in text, break_start text, break_end text, clock_out text, break_mins numeric, break_count integer, break_detail text, worked_hours numeric, regular_hours numeric, ot_hours numeric, ot_paid_hours numeric, ot_status text, undertime_hours numeric, standard_hours numeric, night_hours numeric, night_window text, hourly_rate numeric, day_pay numeric, night_diff_suggested numeric, sources text, is_holiday boolean, holiday_name text, art82_exempt boolean, nd_paid_hours numeric, nd_status text)
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

      -- approved night differential for THIS day (same shape as OT)
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
      day_pay := ROUND(regular_hours*v_hourly + ot_paid_hours*v_hourly*1.25 + nd_paid_hours*v_hourly*0.10, 2);
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

CREATE OR REPLACE FUNCTION public.hr_night_diff_review(p_cutoff_id uuid, p_staff_id uuid)
 RETURNS TABLE(work_date date, night_hours numeric, approved_hours numeric, status text, review_note text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM hr_payroll_cut_offs WHERE id=p_cutoff_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Cutoff not found'; END IF;
  RETURN QUERY
  SELECT dd.work_date, dd.night_hours,
         COALESCE(n.approved_hours, 0)::numeric,
         COALESCE(n.status,'UNREVIEWED')::text,
         n.review_note
  FROM hr_payroll_daily(p_cutoff_id, p_staff_id) dd
  LEFT JOIN hr_night_diff_requests n
    ON n.staff_id = p_staff_id AND n.work_date = dd.work_date
  WHERE dd.night_hours > 0
  ORDER BY dd.work_date;
END $function$;

CREATE OR REPLACE FUNCTION public.hr_night_diff_decide(p_cutoff_id uuid, p_staff_id uuid, p_approve boolean, p_actor text, p_note text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE c record; r record; n int := 0;
BEGIN
  SELECT * INTO c FROM hr_payroll_cut_offs WHERE id=p_cutoff_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Cutoff not found'; END IF;
  IF COALESCE(c.payroll_status,'OPEN') IN ('FINALIZED','PAID') THEN
    RAISE EXCEPTION 'Cutoff is % — cannot change night differential', c.payroll_status;
  END IF;

  FOR r IN SELECT dd.work_date, dd.night_hours FROM hr_payroll_daily(p_cutoff_id,p_staff_id) dd
           WHERE dd.night_hours > 0
  LOOP
    INSERT INTO hr_night_diff_requests
      (tenant_id, staff_id, work_date, night_hours, approved_hours, status, reviewed_at, review_note)
    VALUES (c.tenant_id, p_staff_id, r.work_date, r.night_hours,
            CASE WHEN p_approve THEN r.night_hours ELSE 0 END,
            CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END,
            now(), COALESCE(p_note,'') || ' [' || COALESCE(p_actor,'?') || ']')
    ON CONFLICT (staff_id, work_date) DO UPDATE SET
      night_hours    = EXCLUDED.night_hours,
      approved_hours = EXCLUDED.approved_hours,
      status         = EXCLUDED.status,
      reviewed_at    = now(),
      review_note    = EXCLUDED.review_note,
      updated_at     = now();
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

-- hr_compute_payroll: night_diff_hours / night_diff_pay come from approvals, not from a typed amount.
CREATE OR REPLACE FUNCTION public.hr_compute_payroll(p_cutoff_id uuid, p_actor text DEFAULT NULL::text)
 RETURNS TABLE(out_staff_code text, out_full_name text, out_days integer, out_regular_hours numeric, out_ot_hours numeric, out_gross numeric, out_deductions numeric, out_net numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c record; s record; d date; h record; ex record;
  v_reg numeric; v_ot_actual numeric; v_ot_paid numeric; v_days int; v_ut numeric; v_std numeric;
  v_hourly numeric; v_basic numeric; v_gross numeric; v_ded numeric;
  v_manual numeric; v_govt numeric; v_13 numeric; v_elig boolean;
  v_nd_hours numeric; v_nd_pay numeric;
BEGIN
  SELECT * INTO c FROM hr_payroll_cut_offs WHERE id=p_cutoff_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Cutoff not found'; END IF;
  IF COALESCE(c.payroll_status,'OPEN') IN ('FINALIZED','PAID') THEN
    RAISE EXCEPTION 'Cutoff is % — reopen it before recomputing', c.payroll_status;
  END IF;

  FOR s IN
    SELECT m.id, m.staff_code AS code, m.full_name AS name, m.employment_type, m.role,
           m.pay_basis, COALESCE(m.hourly_rate,0) hr, COALESCE(m.daily_rate,0) dr,
           COALESCE(m.monthly_rate,0) mr, COALESCE(m.standard_hours_per_day,8) std,
           COALESCE(m.art82_exempt,false) exempt
    FROM hr_staff_master m
    WHERE m.tenant_id=c.tenant_id AND m.employment_status='ACTIVE'
  LOOP
    v_reg:=0; v_ot_actual:=0; v_days:=0; v_ut:=0; v_std:=s.std;
    d := c.start_date;
    WHILE d <= c.end_date LOOP
      SELECT * INTO h FROM hr_daily_hours(c.tenant_id,s.id,d);
      IF COALESCE(h.worked_hours,0) > 0 THEN
        v_days:=v_days+1; v_reg:=v_reg+COALESCE(h.regular_hours,0);
        v_ot_actual:=v_ot_actual+COALESCE(h.overtime_hours,0);
        IF COALESCE(h.overtime_hours,0)=0 THEN v_ut:=v_ut+GREATEST(v_std-COALESCE(h.regular_hours,0),0); END IF;
      END IF;
      d:=d+1;
    END LOOP;
    CONTINUE WHEN v_days=0;

    IF s.exempt THEN
      v_ot_paid := 0; v_nd_hours := 0;    -- Art. 82: no overtime or night-differential entitlement
    ELSE
      SELECT COALESCE(SUM(o.actual_hours),0) INTO v_ot_paid
      FROM hr_overtime_requests o
      WHERE o.staff_id=s.id AND o.status='APPROVED'
        AND o.work_date BETWEEN c.start_date AND c.end_date;
      SELECT COALESCE(SUM(n.approved_hours),0) INTO v_nd_hours
      FROM hr_night_diff_requests n
      WHERE n.staff_id=s.id AND n.status='APPROVED'
        AND n.work_date BETWEEN c.start_date AND c.end_date;
    END IF;

    v_hourly := CASE WHEN s.pay_basis='HOURLY' THEN s.hr
                     WHEN s.pay_basis='MONTHLY' THEN (s.mr*12)/(52*6*v_std)
                     ELSE s.dr/NULLIF(v_std,0) END;
    v_basic  := ROUND(v_reg*v_hourly + v_ot_paid*v_hourly*1.25, 2);
    v_nd_pay := ROUND(v_nd_hours*v_hourly*0.10, 2);

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
      c.tenant_id,p_cutoff_id,s.id,s.employment_type,s.pay_basis,
      ROUND(v_hourly,4),s.dr,s.mr,v_reg,v_ot_actual,v_ot_paid,ROUND(v_ut*60),
      ROUND(v_reg*v_hourly,2),ROUND(v_ot_paid*v_hourly*1.25,2),v_nd_hours,v_nd_pay,
      v_gross,v_13,v_govt,
      v_ded,ROUND(v_ded+v_govt,2),ROUND(v_gross-v_ded-v_govt,2),'DRAFT',
      'Computed '||to_char(now() AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI')||
      ' from '||v_days||' day(s)'||COALESCE(' by '||p_actor,'')||
      CASE WHEN s.exempt THEN ' | Art.82 exempt — no OT / night differential entitlement' ELSE '' END)
    ON CONFLICT (cutoff_id,staff_id) DO UPDATE SET
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

REVOKE ALL ON FUNCTION public.hr_night_diff_review(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hr_night_diff_decide(uuid,uuid,boolean,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_night_diff_review(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.hr_night_diff_decide(uuid,uuid,boolean,text,text) TO service_role;
