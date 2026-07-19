CREATE TABLE "building" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"building_type_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "building_type" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"build_seconds" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"speed" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"origin_x" integer NOT NULL,
	"origin_y" integer NOT NULL,
	"dest_x" integer NOT NULL,
	"dest_y" integer NOT NULL,
	"building_type_id" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"travel_done_at" timestamp with time zone NOT NULL,
	"complete_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player" (
	"id" serial PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "building" ADD CONSTRAINT "building_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "building" ADD CONSTRAINT "building_building_type_id_building_type_id_fk" FOREIGN KEY ("building_type_id") REFERENCES "public"."building_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character" ADD CONSTRAINT "character_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_building_type_id_building_type_id_fk" FOREIGN KEY ("building_type_id") REFERENCES "public"."building_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "building_player_tile_idx" ON "building" USING btree ("player_id","x","y");