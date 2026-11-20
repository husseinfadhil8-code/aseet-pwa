CREATE TABLE ai_analyses(id TEXT PRIMARY KEY,page_id TEXT NOT NULL,conversation_id TEXT NOT NULL,model TEXT NOT NULL,result_cipher TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,neurons_estimated REAL,created_at INTEGER NOT NULL);
CREATE INDEX ai_analyses_conversation ON ai_analyses(page_id,conversation_id,created_at);
