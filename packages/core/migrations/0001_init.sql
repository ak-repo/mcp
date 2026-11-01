-- Amounts are safe integer paise. STRICT tables reject fractional integer fields.
-- Nullable partner/timestamps represent an unassigned or unfinished delivery.

CREATE TABLE customers (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone TEXT NOT NULL CHECK (length(trim(phone)) > 0),
  email TEXT NOT NULL CHECK (length(trim(email)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
) STRICT;

CREATE TABLE addresses (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  line1 TEXT NOT NULL CHECK (length(trim(line1)) > 0),
  area TEXT NOT NULL CHECK (length(trim(area)) > 0),
  city TEXT NOT NULL CHECK (length(trim(city)) > 0),
  pincode TEXT NOT NULL CHECK (length(pincode) = 6 AND pincode GLOB '[1-9][0-9][0-9][0-9][0-9][0-9]')
) STRICT;

CREATE TABLE restaurants (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  cuisine TEXT NOT NULL CHECK (length(trim(cuisine)) > 0),
  city TEXT NOT NULL CHECK (length(trim(city)) > 0),
  area TEXT NOT NULL CHECK (length(trim(area)) > 0),
  rating REAL NOT NULL CHECK (rating BETWEEN 0 AND 5),
  prep_time_min INTEGER NOT NULL CHECK (prep_time_min BETWEEN 0 AND 9007199254740991),
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1))
) STRICT;

CREATE TABLE menu_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0 AND price_paise <= 9007199254740991),
  is_veg INTEGER NOT NULL CHECK (is_veg IN (0, 1)),
  is_available INTEGER NOT NULL CHECK (is_available IN (0, 1))
) STRICT;

CREATE TABLE orders (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  address_id TEXT NOT NULL REFERENCES addresses(id),
  status TEXT NOT NULL CHECK (status IN ('placed', 'accepted', 'preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled')),
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0 AND subtotal_paise <= 9007199254740991),
  tax_paise INTEGER NOT NULL CHECK (tax_paise >= 0 AND tax_paise <= 9007199254740991),
  delivery_fee_paise INTEGER NOT NULL CHECK (delivery_fee_paise >= 0 AND delivery_fee_paise <= 9007199254740991),
  platform_fee_paise INTEGER NOT NULL CHECK (platform_fee_paise >= 0 AND platform_fee_paise <= 9007199254740991),
  discount_paise INTEGER NOT NULL CHECK (discount_paise >= 0 AND discount_paise <= 9007199254740991),
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0 AND total_paise <= 9007199254740991),
  notes TEXT,
  cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(trim(cancel_reason)) > 0),
  placed_at TEXT NOT NULL CHECK (length(trim(placed_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
) STRICT;

CREATE TABLE order_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  order_id TEXT NOT NULL REFERENCES orders(id),
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
  name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) > 0),
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0 AND unit_price_paise <= 9007199254740991),
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 9007199254740991)
) STRICT;

CREATE TABLE order_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  order_id TEXT NOT NULL REFERENCES orders(id),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('placed', 'accepted', 'preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled')),
  to_status TEXT NOT NULL CHECK (to_status IN ('placed', 'accepted', 'preparing', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled')),
  actor TEXT NOT NULL CHECK (actor IN ('system', 'ops', 'ai')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  at TEXT NOT NULL CHECK (length(trim(at)) > 0)
) STRICT;

CREATE TABLE delivery_partners (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone TEXT NOT NULL CHECK (length(trim(phone)) > 0),
  vehicle TEXT NOT NULL CHECK (length(trim(vehicle)) > 0),
  status TEXT NOT NULL CHECK (status IN ('available', 'busy', 'offline'))
) STRICT;

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  order_id TEXT NOT NULL REFERENCES orders(id),
  partner_id TEXT REFERENCES delivery_partners(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'assigned', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled')),
  eta_min INTEGER CHECK (eta_min IS NULL OR eta_min BETWEEN 0 AND 9007199254740991),
  assigned_at TEXT,
  picked_up_at TEXT,
  delivered_at TEXT
) STRICT;

CREATE TABLE payments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  order_id TEXT NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL CHECK (method IN ('upi', 'card', 'cod', 'wallet')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0 AND amount_paise <= 9007199254740991),
  txn_ref TEXT CHECK (txn_ref IS NULL OR length(trim(txn_ref)) > 0)
) STRICT;

CREATE TABLE refunds (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  order_id TEXT NOT NULL REFERENCES orders(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 9007199254740991),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor TEXT NOT NULL CHECK (actor IN ('system', 'ops', 'ai')),
  idempotency_key TEXT UNIQUE CHECK (idempotency_key IS NULL OR length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
) STRICT;

CREATE TABLE invoices (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  invoice_no TEXT NOT NULL UNIQUE CHECK (invoice_no GLOB 'INV-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]*' AND substr(invoice_no, 14) NOT GLOB '*[^0-9]*'),
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0 AND subtotal_paise <= 9007199254740991),
  tax_paise INTEGER NOT NULL CHECK (tax_paise >= 0 AND tax_paise <= 9007199254740991),
  fees_paise INTEGER NOT NULL CHECK (fees_paise >= 0 AND fees_paise <= 9007199254740991),
  discount_paise INTEGER NOT NULL CHECK (discount_paise >= 0 AND discount_paise <= 9007199254740991),
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0 AND total_paise <= 9007199254740991),
  issued_at TEXT NOT NULL CHECK (length(trim(issued_at)) > 0)
) STRICT;

CREATE TABLE tool_call_log (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  session_id TEXT CHECK (session_id IS NULL OR length(trim(session_id)) > 0),
  tool TEXT NOT NULL CHECK (length(trim(tool)) > 0),
  args_json TEXT NOT NULL CHECK (json_valid(args_json)),
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('NOT_FOUND', 'VALIDATION', 'INVALID_TRANSITION', 'LIMIT_EXCEEDED', 'CONFIRMATION_REQUIRED', 'CONFLICT', 'INTERNAL')),
  latency_ms INTEGER NOT NULL CHECK (latency_ms BETWEEN 0 AND 9007199254740991),
  actor TEXT NOT NULL CHECK (actor IN ('system', 'ops', 'ai')),
  at TEXT NOT NULL CHECK (length(trim(at)) > 0)
) STRICT;

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(trim(key)) > 0),
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
) STRICT;

CREATE INDEX idx_orders_status_placed_at ON orders(status, placed_at);
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_deliveries_partner_status ON deliveries(partner_id, status);
CREATE INDEX idx_order_events_order_id ON order_events(order_id);
CREATE INDEX idx_tool_call_log_at ON tool_call_log(at);
