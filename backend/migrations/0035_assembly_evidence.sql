-- 装机检测版本保留已完成附件引用；原检查记录不改写。
ALTER TABLE sale_checklists ADD COLUMN result_evidence_json TEXT NOT NULL DEFAULT '[]';
