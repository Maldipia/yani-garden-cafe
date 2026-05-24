-- Enable Supabase Realtime on dine_in_orders table
-- Applied: 2026-05-24
-- Allows frontend to subscribe to INSERT/UPDATE events via WebSocket
-- instead of 5-second HTTP polling. Kitchen and admin board now receive
-- instant push when any order changes status.
ALTER PUBLICATION supabase_realtime ADD TABLE dine_in_orders;
