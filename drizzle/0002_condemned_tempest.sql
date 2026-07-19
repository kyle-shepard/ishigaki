DROP INDEX "building_player_tile_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "building_tile_idx" ON "building" USING btree ("x","y");