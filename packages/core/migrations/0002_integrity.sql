-- One delivery and one payment per order; existing duplicates abort this migration.
CREATE UNIQUE INDEX idx_deliveries_order_id ON deliveries(order_id);
CREATE UNIQUE INDEX idx_payments_order_id ON payments(order_id);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_refunds_payment_id ON refunds(payment_id);
CREATE INDEX idx_refunds_order_id ON refunds(order_id);

CREATE TRIGGER invoices_immutable_update
BEFORE UPDATE ON invoices
BEGIN
  SELECT RAISE(ABORT, 'Invoices are immutable: UPDATE is forbidden');
END;

CREATE TRIGGER invoices_immutable_delete
BEFORE DELETE ON invoices
BEGIN
  SELECT RAISE(ABORT, 'Invoices are immutable: DELETE is forbidden');
END;
