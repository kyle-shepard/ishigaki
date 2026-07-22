DROP INDEX "building_tile_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "building_tile_idx" ON "building" USING btree ("player_id","x","y");