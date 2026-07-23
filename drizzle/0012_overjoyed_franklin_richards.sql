CREATE TABLE "game_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"growth_per_hour" real NOT NULL,
	CONSTRAINT "game_config_singleton" CHECK ("game_config"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "building_type" ADD COLUMN "housing_capacity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement" ADD COLUMN "population_as_of" timestamp with time zone DEFAULT now() NOT NULL;