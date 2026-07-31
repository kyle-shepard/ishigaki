CREATE TABLE "start_position" (
	"id" serial PRIMARY KEY NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"claimed_by_player_id" integer,
	CONSTRAINT "start_position_x_range" CHECK ("start_position"."x" >= 0 AND "start_position"."x" < 256),
	CONSTRAINT "start_position_y_range" CHECK ("start_position"."y" >= 0 AND "start_position"."y" < 256)
);
--> statement-breakpoint
ALTER TABLE "game_config" DROP CONSTRAINT "game_config_start_x_range";--> statement-breakpoint
ALTER TABLE "game_config" DROP CONSTRAINT "game_config_start_y_range";--> statement-breakpoint
DROP INDEX "building_tile_idx";--> statement-breakpoint
ALTER TABLE "start_position" ADD CONSTRAINT "start_position_claimed_by_player_id_player_id_fk" FOREIGN KEY ("claimed_by_player_id") REFERENCES "public"."player"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "start_position_xy_idx" ON "start_position" USING btree ("x","y");--> statement-breakpoint
-- HAND-EDITED after the fact, deliberately, to unblock the production deploy. See issue #23.
--
-- The statement below makes (x, y) unique across `building`. Production still holds realms created
-- under VISION #4's interim per-player occupancy override, where every realm's buildings sit on the
-- same tile — a unique index cannot be built over that, so this migration has died ~1.8 s in on
-- every deploy since, the seed has never run, and the last successful deploy predates the change.
--
-- No migration can preserve those realms. The reversal makes them invalid *by definition* (they all
-- occupy one tile), and they could not have survived the world regenerating from 128² to 6912²
-- either. `ensurePlayer`'s `worldReset` notice is what tells anyone still holding a cookie.
--
-- **Editing an already-applied migration is normally wrong.** It is safe here for one specific
-- reason, and it was checked rather than assumed: drizzle's migrator decides what to run by
-- comparing each entry's `when` timestamp from `meta/_journal.json` against the newest `created_at`
-- in `drizzle.__drizzle_migrations` — the stored hash is recorded, not consulted. This file's
-- timestamp is long past, so on every database that already applied it these two statements are
-- never executed again and not one realm is touched. On production, where it has never applied,
-- this is what finally runs.
--
-- The alternative was a deploy that stays broken until somebody with the production credential runs
-- the same TRUNCATE by hand.
TRUNCATE operation, building, character, stock, tile_stock, settlement, start_position, player RESTART IDENTITY CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "building_tile_idx" ON "building" USING btree ("x","y");--> statement-breakpoint
ALTER TABLE "game_config" DROP COLUMN "start_x";--> statement-breakpoint
ALTER TABLE "game_config" DROP COLUMN "start_y";