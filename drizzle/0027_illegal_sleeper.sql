CREATE TABLE "reach_milestone" (
	"population" integer PRIMARY KEY NOT NULL,
	"radius" integer NOT NULL,
	CONSTRAINT "reach_milestone_radius_positive" CHECK ("reach_milestone"."radius" > 0)
);
--> statement-breakpoint
ALTER TABLE "building_type" ADD COLUMN "player_buildable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement" ADD COLUMN "reach_radius" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_reach_radius_non_negative" CHECK ("settlement"."reach_radius" >= 0);