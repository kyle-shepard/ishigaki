-- `IF EXISTS` is hand-added, and load-bearing: drizzle-kit emits the DROP TABLE ... CASCADE first,
-- which already takes tile_stock's foreign key with it, and then emits a DROP CONSTRAINT for that
-- same now-absent key. Left as generated this migration fails on its last statement against a
-- database where its first statement succeeded — which is every database.
ALTER TABLE "tile_stock" DROP CONSTRAINT IF EXISTS "tile_stock_x_y_tile_x_y_fk";--> statement-breakpoint
DROP TABLE IF EXISTS "tile" CASCADE;
