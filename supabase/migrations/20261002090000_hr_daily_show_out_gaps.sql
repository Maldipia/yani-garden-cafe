-- Payroll daily breakdown: a mid-shift clock-out → clock-in gap now shows in the Break column,
-- labelled "out" (e.g. "12:53-04:23 out, 08:59-09:18"). Display only — pay still comes from
-- hr_daily_hours, which already leaves that gap unpaid.
DO $mig$
DECLARE src text; n text;
BEGIN
  src := pg_get_functiondef('public.hr_payroll_daily(uuid,uuid)'::regprocedure);
  n := replace(src, 'AND t.event_type IN (''BREAK_START'',''BREAK_END'')),',
                    'AND t.event_type IN (''BREAK_START'',''BREAK_END'',''CLOCK_OUT'',''CLOCK_IN'')),');
  n := replace(n,   'pairs AS (SELECT a.event_time bs,',
                    'pairs AS (SELECT ''''::text tag, a.event_time bs,');
  n := replace(n,   'FROM ev a WHERE a.event_type=''BREAK_START'')',
                    'FROM ev a WHERE a.event_type=''BREAK_START''
                UNION ALL
                SELECT '' out'', a.event_time,
                (SELECT min(b.event_time) FROM ev b WHERE b.event_type=''CLOCK_IN'' AND b.event_time>a.event_time)
                FROM ev a WHERE a.event_type=''CLOCK_OUT'')');
  n := replace(n,   'to_char(be AT TIME ZONE ''Asia/Manila'',''HH12:MI''),'', '' ORDER BY bs)',
                    'to_char(be AT TIME ZONE ''Asia/Manila'',''HH12:MI'')||tag,'', '' ORDER BY bs)');
  IF position('''CLOCK_OUT'',''CLOCK_IN'')),' IN n) = 0 OR position('''''::text tag' IN n) = 0
     OR position('event_type=''CLOCK_OUT'')' IN n) = 0 OR position('||tag,' IN n) = 0 THEN
    RAISE EXCEPTION 'hr_payroll_daily patch did not apply';
  END IF;
  EXECUTE n;
END $mig$;
