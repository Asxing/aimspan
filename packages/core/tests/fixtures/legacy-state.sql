-- Synthetic pre-existing database, including inactive data in both storage layouts.
CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE metadata(key TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL);
CREATE TABLE operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
CREATE TABLE source_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
CREATE TABLE imported(source TEXT PRIMARY KEY,report TEXT NOT NULL);
CREATE TABLE attention(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL);
CREATE TABLE contexts(id TEXT PRIMARY KEY,goal TEXT NOT NULL);
CREATE TABLE briefs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE deliveries(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL);
CREATE TABLE receipts(id TEXT PRIMARY KEY,body TEXT NOT NULL);
INSERT INTO attention VALUES('question', '保留待办原文', 'snoozed');
INSERT INTO contexts VALUES('context', '保留目标原文');
INSERT INTO briefs VALUES('brief', '保留简报原文');
INSERT INTO deliveries VALUES('sent', '保留发送原文', 'sending');
INSERT INTO receipts VALUES('receipt', '保留回执原文');
INSERT INTO records VALUES
  ('attention', 'question', 2, '{"id":"question","revision":2,"updatedAt":"2026-10-12","status":"snoozed","snoozedUntil":"2026-10-12","reason":"保留待办原文"}'),
  ('context', 'context', 3, '{"id":"context","revision":3,"updatedAt":"2026-10-12","goal":"保留目标原文"}'),
  ('brief', 'brief', 4, '{"id":"brief","revision":4,"updatedAt":"2026-10-12","output":{"progress":"保留简报原文"}}'),
  ('delivery', 'sent', 1, '{"id":"sent","revision":1,"updatedAt":"2026-10-12","status":"sending","body":"保留发送原文"}'),
  ('receipt', 'receipt', 1, '{"id":"receipt","revision":1,"updatedAt":"2026-10-12","body":"保留回执原文"}'),
  ('job', 'job', 1, '{"id":"job","revision":1,"updatedAt":"2026-10-12","fingerprint":"synthetic"}');
INSERT INTO metadata VALUES
  ('deviceId', '"__aimspan_fixture__-device"'),
  ('settings', '{"roots":[],"observeAll":true,"notifications":true,"pinned":false,"language":"zh","followupEnabled":true,"model":{"provider":"openai","model":"synthetic"}}'),
  ('context:session', '"context"'),
  ('followup-error:session', '"保留错误原文"');
INSERT INTO changes(kind,id,json) SELECT kind,id,json FROM records;
INSERT INTO operations VALUES('legacy-operation','synthetic','{"retained":true}');
INSERT INTO source_events VALUES('legacy-event','session');
INSERT INTO imported VALUES('/__aimspan_fixture__/aimspan.sqlite3','{"retained":true}');
