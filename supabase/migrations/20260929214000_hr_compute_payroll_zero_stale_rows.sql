-- A staff member whose attendance drops to zero hours (a correction removed
-- their only closed day) used to keep the last computed row untouched — a
-- stale gross that would be paid. Now such a row is zeroed (manual premiums
-- and deductions kept) and marked "No attendance in this cut-off".
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

    IF v_days = 0 THEN
      -- No hours: a previously computed row must not keep an old gross.
      UPDATE hr_payroll_details SET
        approved_regular_hours=0, actual_ot_hours=0, approved_ot_hours=0, undertime_minutes=0,
        regular_pay=0, overtime_pay=0, night_diff_hours=0, night_diff_pay=0, thirteenth_month_accrual=0,
        gross_pay = ROUND(COALESCE(holiday_pay,0)+COALESCE(rest_day_pay,0)+COALESCE(allowances,0)+COALESCE(incentives,0)+COALESCE(tips_share,0),2),
        net_pay   = ROUND(COALESCE(holiday_pay,0)+COALESCE(rest_day_pay,0)+COALESCE(allowances,0)+COALESCE(incentives,0)+COALESCE(tips_share,0)
                          - COALESCE(total_deductions,0),2),
        notes = 'No attendance in this cut-off (recomputed '||to_char(now() AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI')||COALESCE(' by '||p_actor,'')||')',
        updated_at = now()
      WHERE cutoff_id=p_cutoff_id AND staff_id=s.id;
      CONTINUE;
    END IF;

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
REVOKE ALL ON FUNCTION public.hr_compute_payroll(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_compute_payroll(uuid,text) TO service_role;
