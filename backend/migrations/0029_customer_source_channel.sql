-- E04 客户来源：留空代表尚未记录，不作为建档、报价的前置条件。
ALTER TABLE customers
  ADD COLUMN source_channel TEXT NOT NULL DEFAULT ''
  CHECK (source_channel IN ('', 'walk_in', 'phone', 'wechat', 'referral', 'mini_program', 'other'));
