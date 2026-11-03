-- Ordinary tool_call_log rowids can be reused after retention. Keep a durable feed sequence.
CREATE TABLE tool_call_feed_sequence (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL UNIQUE REFERENCES tool_call_log(id) ON DELETE CASCADE
) STRICT;
INSERT INTO tool_call_feed_sequence (seq, call_id)
  SELECT rowid, id FROM tool_call_log ORDER BY rowid;
CREATE TRIGGER tool_call_feed_insert AFTER INSERT ON tool_call_log
BEGIN
  INSERT INTO tool_call_feed_sequence (call_id) VALUES (NEW.id);
END;
