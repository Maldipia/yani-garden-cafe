-- Count movements carry "theoretical X, physical Y" so the variance stays readable forever.
DO $mig$
DECLARE src text; n text; tp text;
BEGIN
  tp := $t$CONCAT_WS(' · ', 'theoretical ' || trim(to_char(v_exp,'FM999999990.###')) || ', physical ' || trim(to_char(l.counted,'FM999999990.###')), NULLIF(l.note,''))$t$;
  src := pg_get_functiondef('public.inv_submit_count(jsonb,text,text)'::regprocedure);
  n := replace(src, $a$p_actor, l.note, 'COUNTED')$a$, 'p_actor, ' || tp || $b$, 'COUNTED')$b$);
  n := replace(n,   $a$p_actor, l.note, 'FOUND')$a$,   'p_actor, ' || tp || $b$, 'FOUND')$b$);
  n := replace(n,   $a$'count', v_ref, p_actor, l.note);$a$, $b$'count', v_ref, p_actor, $b$ || tp || ');');
  IF (length(n) - length(replace(n, 'theoretical ', ''))) / length('theoretical ') < 4 THEN
    RAISE EXCEPTION 'count notes patch incomplete';
  END IF;
  EXECUTE n;
END $mig$;
