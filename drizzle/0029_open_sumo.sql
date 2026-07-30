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
CREATE UNIQUE INDEX "building_tile_idx" ON "building" USING btree ("x","y");--> statement-breakpoint
ALTER TABLE "game_config" DROP COLUMN "start_x";--> statement-breakpoint
ALTER TABLE "game_config" DROP COLUMN "start_y";