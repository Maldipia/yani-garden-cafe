-- Payroll cut-offs are created automatically: the current semi-monthly period always exists.
-- Pattern (same as the existing ones):
--   Cutoff A = 1–15,  paid on the 25th of the same month
--   Cutoff B = 16–end, paid on the 10th of the next month
-- One cut-off per tenant per start date (unique index), so it can never be created twice.
CREATE UNIQUE INDEX IF NOT EXISTS hr_payroll_cut_offs_tenant_start_uq ON public.hr_payroll_cut_offs (tenant_id, start_date);

CREATE OR REPLACE FUNCTION public.hr_ensure_cutoff(p_tenant uuid, p_day date DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  d date := COALESCE(p_day, (now() AT TIME ZONE 'Asia/Manila')::date);
  m date := date_trunc('month', d)::date;
  s date; e date; p date; nm text; v_id uuid;
BEGIN
  IF extract(day FROM d) <= 15 THEN
    s := m; e := m + 14; p := m + 24;
    nm := to_char(m, 'Mon YYYY') || ' — Cutoff A (1-15)';
  ELSE
    s := m + 15; e := (m + interval '1 month - 1 day')::date; p := (m + interval '1 month')::date + 9;
    nm := to_char(m, 'Mon YYYY') || ' — Cutoff B (16-' || extract(day FROM e)::int || ')';
  END IF;
  SELECT id INTO v_id FROM hr_payroll_cut_offs WHERE tenant_id = p_tenant AND start_date = s;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO hr_payroll_cut_offs (tenant_id, cutoff_name, start_date, end_date, pay_date, payroll_status, notes)
  VALUES (p_tenant, nm, s, e, p, 'OPEN', 'Created automatically')
  ON CONFLICT (tenant_id, start_date) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM hr_payroll_cut_offs WHERE tenant_id = p_tenant AND start_date = s; END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.hr_ensure_cutoff(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_ensure_cutoff(uuid, date) TO service_role;

-- create the one that was missed
SELECT public.hr_ensure_cutoff('11111111-1111-4111-8111-111111111111', DATE '2026-10-01');
