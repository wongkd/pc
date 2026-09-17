-- SN hardening for existing 0004_sn deployments.
-- Apply after 0004_sn.sql. This migration is additive and must not be re-run.

-- A serial number may have only one effective order-item binding.
CREATE UNIQUE INDEX uq_order_item_sn_effective_sn
  ON order_item_sn(sn_id)
  WHERE unbound_at IS NULL;

-- Enforce order ownership, product matching and ordered quantity at the database boundary.
CREATE TRIGGER order_item_sn_before_insert_hardening
BEFORE INSERT ON order_item_sn
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN serial_numbers sn ON sn.id = NEW.sn_id
  WHERE oi.id = NEW.order_item_id
    AND oi.source_item_id IS NOT NULL
    AND sn.store_id = o.store_id
    AND sn.product_id = oi.source_item_id
    AND (
      SELECT COUNT(*)
      FROM order_item_sn existing
      WHERE existing.order_item_id = NEW.order_item_id
        AND existing.unbound_at IS NULL
    ) < oi.quantity
)
BEGIN
  SELECT RAISE(ABORT, 'SN binding must match the order product and available quantity');
END;

-- An inbound event may only be created once for a serial number.
CREATE UNIQUE INDEX uq_sn_events_inbound_once
  ON sn_events(sn_id)
  WHERE event_type = 'inbound';
