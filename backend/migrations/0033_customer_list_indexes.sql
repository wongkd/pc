-- 0033 · 客户台账分页与订单汇总读取索引
--
-- 按门店/状态/更新时间稳定取页；客户汇总通过门店与手机号关联订单。
-- 金额列放在索引末尾，使订单数、总额、已收金额汇总可以仅扫描覆盖索引。
CREATE INDEX idx_customers_store_status_updated
  ON customers(store_id, status, updated_at DESC, id DESC);

CREATE INDEX idx_orders_store_customer_totals
  ON orders(store_id, customer_phone, total_amount_cents, received_amount_cents);
