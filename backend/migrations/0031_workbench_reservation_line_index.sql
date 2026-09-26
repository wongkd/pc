-- P03 · 工作台的缺件口径按「行」查有效数量占用，而既有索引里没有 line_ref 这一列。
--
-- 依据：本地隔离库（miniflare + 本目录全量迁移重放 + 合成数据）实测的查询计划与耗时。
--   缺件子查询的谓词是：
--     r.store_id = <本店> AND r.line_ref = <行 id> AND r.status = 'active'
--     AND r.quantity_bucket_ref IS NOT NULL  →  SUM(r.qty)
--   既有索引只有 idx_stock_reservations_order(store_id, order_ref) 与
--   idx_stock_reservations_bucket(store_id, quantity_bucket_ref, created_at DESC)；
--   计划退化成用桶索引做「本店所有数量件占用」的范围扫描（EXPLAIN 里是
--   `SEARCH r USING INDEX idx_stock_reservations_bucket (store_id=? AND quantity_bucket_ref>?)`），
--   **每查一行就扫一遍全店占用** ⇒ 代价随「行数 × 店内占用行数」增长。
--   实测同一语句：400 单 / 约 1.5k 行的店，全集聚合语句 390ms → 加本索引 78ms；
--   扣掉本机 workerd 的固定往返开销后，纯 SQL 从约 313ms 降到约 1ms。
--
-- 为什么是这三列 + 这个 WHERE：
--   line_ref 与 store_id 都是查询里的等值条件，一起放进索引才能一次定位；qty 是唯一被读取的列，
--   带上它让 SUM(qty) 不必回落主表。WHERE 与查询里的 status / quantity_bucket_ref 条件一致 ⇒
--   局部索引，只覆盖「有效数量件占用」这一小部分行，不给逐件占用与历史行增加写放大。
-- 受益的查询（同一段谓词）：工作台缺件判定、querySaleOrders 的 shortage_count、
--   报价确认前的按行占用汇总（line_ref IN (...) 且 SUM(qty)，本索引可覆盖）。
CREATE INDEX idx_stock_reservations_active_line
  ON stock_reservations(line_ref, store_id, qty)
  WHERE status = 'active' AND quantity_bucket_ref IS NOT NULL;
