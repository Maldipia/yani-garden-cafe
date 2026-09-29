-- ─────────────────────────────────────────────────────────────────────────────
-- HR attendance: a shift that crosses midnight belongs to the day it started.
--
-- Before this, every reader of hr_time_logs (the clock-in gate, the kiosk
-- buttons, the kiosk board, the HR list, payroll) looked only at TODAY's
-- log_date. Closers leave at 12:15–1:40 AM, so after midnight the kiosk saw
-- "no logs today" = OUT, the QR scan auto-clocked them IN, and they tapped OUT
-- 10 seconds later. Payroll then showed the real day with "OUT —" and the next
-- day as a 20-second shift (31 such pairs across 6 staff since Sep 9).
--
-- Rule, in one place (hr_clock_state): until 06:00 AM, if yesterday's shift was
-- never closed, yesterday is still the live shift. A tap then is recorded with
-- yesterday's log_date. After 06:00 an unclosed shift is left open for a manual
-- correction, exactly as before — nothing is auto-closed or invented.
-- (Earliest real clock-in on record is 7:28 AM; latest after-midnight tap 2:38 AM.)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. The single source of truth for "which shift is this person on right now".
CREATE OR REPLACE FUNCTION public.hr_clock_state(
  p_tenant uuid, p_staff_id uuid, p_at timestamptz DEFAULT clock_timestamp())
RETURNS TABLE(shift_date date, state text, last_event text, last_event_time timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_local timestamp := p_at AT TIME ZONE 'Asia/Manila';
  v_today date      := v_local::date;
  r record;
BEGIN
  IF v_local::time < TIME '06:00' THEN
    SELECT t.event_type, t.event_time INTO r FROM hr_time_logs t
     WHERE t.tenant_id=p_tenant AND t.staff_id=p_staff_id AND t.log_date=v_today-1
     ORDER BY t.event_time DESC, t.created_at DESC LIMIT 1;
    IF r.event_type IN ('CLOCK_IN','BREAK_END','BROKEN_TIME_END','BREAK_START','BROKEN_TIME_START') THEN
      shift_date := v_today-1;
      state := CASE r.event_type WHEN 'BREAK_START' THEN 'ON_BREAK'
                                 WHEN 'BROKEN_TIME_START' THEN 'ON_BROKEN'
                                 ELSE 'IN' END;
      last_event := r.event_type; last_event_time := r.event_time;
      RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT t.event_type, t.event_time INTO r FROM hr_time_logs t
   WHERE t.tenant_id=p_tenant AND t.staff_id=p_staff_id AND t.log_date=v_today
   ORDER BY t.event_time DESC, t.created_at DESC LIMIT 1;
  shift_date := v_today;
  state := CASE
    WHEN r.event_type IS NULL THEN 'OUT'
    WHEN r.event_type IN ('CLOCK_IN','BREAK_END','BROKEN_TIME_END') THEN 'IN'
    WHEN r.event_type = 'BREAK_START'       THEN 'ON_BREAK'
    WHEN r.event_type = 'BROKEN_TIME_START' THEN 'ON_BROKEN'
    ELSE 'OUT' END;
  last_event := r.event_type; last_event_time := r.event_time;
  RETURN NEXT;
END $$;

-- 2. Same thing for every active staff member (kiosk board, HR list).
CREATE OR REPLACE FUNCTION public.hr_clock_state_all(p_tenant uuid)
RETURNS TABLE(staff_id uuid, staff_code text, shift_date date, state text,
              last_event text, last_event_time timestamptz,
              worked_seconds bigint, is_open boolean, event_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE s record; st record; h record;
BEGIN
  FOR s IN SELECT m.id, m.staff_code FROM hr_staff_master m
            WHERE m.tenant_id=p_tenant AND m.employment_status='ACTIVE'
            ORDER BY m.full_name LOOP
    SELECT * INTO st FROM hr_clock_state(p_tenant, s.id);
    SELECT * INTO h  FROM hr_daily_hours(p_tenant, s.id, st.shift_date);
    staff_id := s.id; staff_code := s.staff_code;
    shift_date := st.shift_date; state := st.state;
    last_event := st.last_event; last_event_time := st.last_event_time;
    worked_seconds := COALESCE(h.worked_seconds,0); is_open := COALESCE(h.is_open,false);
    SELECT count(*)::int INTO event_count FROM hr_time_logs t
     WHERE t.tenant_id=p_tenant AND t.staff_id=s.id AND t.log_date=st.shift_date;
    RETURN NEXT;
  END LOOP;
END $$;

-- 3. The gate: same transitions as before, but judged against the live shift,
--    and the row is stamped with that shift's log_date.
CREATE OR REPLACE FUNCTION public.hr_clock_event(
  p_tenant uuid, p_staff_id uuid, p_event_type text, p_device text, p_location_ip text,
  p_source text DEFAULT NULL::text, p_build text DEFAULT NULL::text)
RETURNS TABLE(ok boolean, message text, event_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_now   timestamptz := clock_timestamp();
  v_state text; v_day date; v_id uuid; v_src text; st record;
BEGIN
  IF p_event_type NOT IN ('CLOCK_IN','CLOCK_OUT','BREAK_START','BREAK_END','BROKEN_TIME_START','BROKEN_TIME_END') THEN
    RETURN QUERY SELECT false, 'Invalid event type', NULL::uuid; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hr_staff_master WHERE id=p_staff_id AND tenant_id=p_tenant) THEN
    RETURN QUERY SELECT false, 'Staff not found', NULL::uuid; RETURN;
  END IF;

  v_src := upper(coalesce(nullif(btrim(p_source),''), 'MANUAL'));
  IF v_src NOT IN ('POS','QR','BIOMETRIC','MANUAL','PIN','KIOSK') THEN
    RETURN QUERY SELECT false, 'Invalid attendance source', NULL::uuid; RETURN;
  END IF;

  SELECT * INTO st FROM hr_clock_state(p_tenant, p_staff_id, v_now);
  v_state := st.state; v_day := st.shift_date;

  IF p_event_type='CLOCK_IN' AND v_state<>'OUT' THEN
    RETURN QUERY SELECT false, 'Already clocked in', NULL::uuid; RETURN; END IF;
  IF p_event_type='CLOCK_OUT' AND v_state<>'IN' THEN
    RETURN QUERY SELECT false,
      CASE WHEN v_state IN ('ON_BREAK','ON_BROKEN') THEN 'End your break first' ELSE 'Not clocked in' END,
      NULL::uuid; RETURN; END IF;
  IF p_event_type='BREAK_START' AND v_state<>'IN' THEN
    RETURN QUERY SELECT false, 'Must be clocked in to start a break', NULL::uuid; RETURN; END IF;
  IF p_event_type='BREAK_END' AND v_state<>'ON_BREAK' THEN
    RETURN QUERY SELECT false, 'No break in progress', NULL::uuid; RETURN; END IF;
  IF p_event_type='BROKEN_TIME_START' AND v_state<>'IN' THEN
    RETURN QUERY SELECT false, 'Must be clocked in', NULL::uuid; RETURN; END IF;
  IF p_event_type='BROKEN_TIME_END' AND v_state<>'ON_BROKEN' THEN
    RETURN QUERY SELECT false, 'No broken-time in progress', NULL::uuid; RETURN; END IF;

  INSERT INTO hr_time_logs (tenant_id, staff_id, log_date, event_type, event_time,
                            device, location_ip, approval_status, attendance_source, notes)
  VALUES (p_tenant, p_staff_id, v_day, p_event_type, v_now,
          p_device, p_location_ip, 'PENDING', v_src,
          CASE WHEN p_build IS NULL THEN NULL ELSE 'client '||substring(p_build,1,12) END)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT true, 'OK', v_id;
END $$;

-- The two older overloads (kept for any caller that still passes fewer args)
-- now delegate, so there is exactly one implementation of the rule.
DROP FUNCTION IF EXISTS public.hr_clock_event(uuid,uuid,text,text,text,text);
CREATE FUNCTION public.hr_clock_event(
  p_tenant uuid, p_staff_id uuid, p_event_type text, p_device text, p_location_ip text, p_source text DEFAULT NULL::text)
RETURNS TABLE(ok boolean, message text, event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT * FROM public.hr_clock_event(p_tenant, p_staff_id, p_event_type, p_device, p_location_ip, p_source, NULL::text); $$;

CREATE OR REPLACE FUNCTION public.hr_clock_event(
  p_tenant uuid, p_staff_id uuid, p_event_type text, p_device text DEFAULT NULL::text, p_location_ip text DEFAULT NULL::text)
RETURNS TABLE(ok boolean, message text, event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT * FROM public.hr_clock_event(p_tenant, p_staff_id, p_event_type, p_device, p_location_ip, NULL::text, NULL::text); $$;

-- 4. Live hours: an open shift keeps counting up to now while it is still the
--    live shift — today, or yesterday's until 06:00 — not only on its own date.
CREATE OR REPLACE FUNCTION public.hr_daily_hours(p_tenant uuid, p_staff_id uuid, p_date date)
RETURNS TABLE(worked_seconds bigint, worked_hours numeric, regular_hours numeric, overtime_hours numeric,
              standard_hours numeric, session_count integer, is_open boolean,
              first_in timestamptz, last_event timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  r            record;
  v_open_in    timestamptz := NULL;
  v_total      bigint := 0;
  v_sessions   int := 0;
  v_std        numeric := 8;
  v_first_in   timestamptz := NULL;
  v_last       timestamptz := NULL;
  v_now        timestamptz := clock_timestamp();
  v_local      timestamp   := clock_timestamp() AT TIME ZONE 'Asia/Manila';
  v_open       boolean := false;
  v_live       boolean;
BEGIN
  SELECT COALESCE(standard_hours_per_day, 8) INTO v_std
  FROM hr_staff_master WHERE id = p_staff_id AND tenant_id = p_tenant;
  IF v_std IS NULL THEN v_std := 8; END IF;

  FOR r IN
    SELECT event_type, event_time
    FROM hr_time_logs
    WHERE tenant_id = p_tenant AND staff_id = p_staff_id AND log_date = p_date
    ORDER BY event_time ASC, created_at ASC
  LOOP
    v_last := r.event_time;
    IF v_first_in IS NULL AND r.event_type = 'CLOCK_IN' THEN
      v_first_in := r.event_time;
    END IF;
    IF r.event_type = 'CLOCK_IN' THEN
      IF v_open_in IS NULL THEN v_open_in := r.event_time; END IF;
    ELSIF r.event_type IN ('CLOCK_OUT','BREAK_START','BROKEN_TIME_START') THEN
      IF v_open_in IS NOT NULL THEN
        v_total := v_total + GREATEST(0, EXTRACT(EPOCH FROM (r.event_time - v_open_in))::bigint);
        v_sessions := v_sessions + 1;
        v_open_in := NULL;
      END IF;
    ELSIF r.event_type IN ('BREAK_END','BROKEN_TIME_END') THEN
      IF v_open_in IS NULL THEN v_open_in := r.event_time; END IF;
    END IF;
  END LOOP;

  IF v_open_in IS NOT NULL THEN
    v_open := true;
    v_live := (p_date = v_local::date)
           OR (p_date = v_local::date - 1 AND v_local::time < TIME '06:00');
    IF v_live THEN
      v_total := v_total + GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_open_in))::bigint);
      v_sessions := v_sessions + 1;
    END IF;
  END IF;

  worked_seconds := v_total;
  worked_hours   := ROUND((v_total / 3600.0)::numeric, 2);
  standard_hours := v_std;
  regular_hours  := ROUND(LEAST(worked_hours, v_std), 2);
  overtime_hours := ROUND(GREATEST(0, worked_hours - v_std), 2);
  session_count  := v_sessions;
  is_open        := v_open;
  first_in       := v_first_in;
  last_event     := v_last;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.hr_clock_state(uuid,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hr_clock_state_all(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_clock_state(uuid,uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.hr_clock_state_all(uuid) TO service_role;
