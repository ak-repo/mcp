-- Durable invalidations shared by every SQLite writer. No historical backfill.
CREATE TABLE change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('order','delivery','partner','payment','refund','invoice')),
  entity_id TEXT NOT NULL,
  order_id TEXT,
  op TEXT NOT NULL CHECK (op IN ('insert','update')),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_change_log_at ON change_log(at);

CREATE TRIGGER change_log_orders_insert AFTER INSERT ON orders
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('order',NEW.id,NEW.id,'insert');
END;

CREATE TRIGGER change_log_orders_update AFTER UPDATE ON orders
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('order',NEW.id,NEW.id,'update');
END;

CREATE TRIGGER change_log_deliveries_insert AFTER INSERT ON deliveries
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('delivery',NEW.id,NEW.order_id,'insert');
END;

CREATE TRIGGER change_log_deliveries_update AFTER UPDATE ON deliveries
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('delivery',NEW.id,NEW.order_id,'update');
END;

CREATE TRIGGER change_log_delivery_partners_insert AFTER INSERT ON delivery_partners
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op)
    SELECT 'partner',NEW.id,d.order_id,'insert' FROM deliveries d
    JOIN orders o ON o.id=d.order_id
    WHERE d.partner_id=NEW.id AND d.status NOT IN ('delivered','cancelled')
      AND o.status NOT IN ('delivered','cancelled');
  INSERT INTO change_log(entity,entity_id,order_id,op)
    SELECT 'partner',NEW.id,NULL,'insert' WHERE NOT EXISTS (
      SELECT 1 FROM deliveries d JOIN orders o ON o.id=d.order_id
      WHERE d.partner_id=NEW.id AND d.status NOT IN ('delivered','cancelled')
        AND o.status NOT IN ('delivered','cancelled'));
END;

CREATE TRIGGER change_log_delivery_partners_update AFTER UPDATE ON delivery_partners
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op)
    SELECT 'partner',NEW.id,d.order_id,'update' FROM deliveries d
    JOIN orders o ON o.id=d.order_id
    WHERE d.partner_id=NEW.id AND d.status NOT IN ('delivered','cancelled')
      AND o.status NOT IN ('delivered','cancelled');
  INSERT INTO change_log(entity,entity_id,order_id,op)
    SELECT 'partner',NEW.id,NULL,'update' WHERE NOT EXISTS (
      SELECT 1 FROM deliveries d JOIN orders o ON o.id=d.order_id
      WHERE d.partner_id=NEW.id AND d.status NOT IN ('delivered','cancelled')
        AND o.status NOT IN ('delivered','cancelled'));
END;

CREATE TRIGGER change_log_payments_insert AFTER INSERT ON payments
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('payment',NEW.id,NEW.order_id,'insert');
END;

CREATE TRIGGER change_log_payments_update AFTER UPDATE ON payments
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('payment',NEW.id,NEW.order_id,'update');
END;

CREATE TRIGGER change_log_refunds_insert AFTER INSERT ON refunds
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('refund',NEW.id,NEW.order_id,'insert');
END;

CREATE TRIGGER change_log_refunds_update AFTER UPDATE ON refunds
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('refund',NEW.id,NEW.order_id,'update');
END;

CREATE TRIGGER change_log_invoices_insert AFTER INSERT ON invoices
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('invoice',NEW.id,NEW.order_id,'insert');
END;

CREATE TRIGGER change_log_invoices_update AFTER UPDATE ON invoices
BEGIN
  INSERT INTO change_log(entity,entity_id,order_id,op) VALUES ('invoice',NEW.id,NEW.order_id,'update');
END;
