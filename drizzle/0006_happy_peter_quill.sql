-- Existing realms cannot be carried across this change. `ensurePlayer` short-circuits for a
-- known player id, so a returning player would never be given a settlement and every stock
-- read would find nothing; backfilling would mean guessing seeded resource and building-type
-- ids from SQL. Deleting the player rows is the codebase's documented path for exactly this:
-- every affected visitor lands on `worldReset` and is told (world.server.ts).
DELETE FROM "operation";--> statement-breakpoint
DELETE FROM "building";--> statement-breakpoint
DELETE FROM "character";--> statement-breakpoint
DELETE FROM "player";--> statement-breakpoint
CREATE TABLE "building_cost" (
	"building_type_id" integer NOT NULL,
	"resource_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "building_cost_building_type_id_resource_id_pk" PRIMARY KEY("building_type_id","resource_id"),
	CONSTRAINT "building_cost_positive" CHECK ("building_cost"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "settlement" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	CONSTRAINT "settlement_player_id_unique" UNIQUE("player_id")
);
--> statement-breakpoint
CREATE TABLE "stock" (
	"settlement_id" integer NOT NULL,
	"resource_id" integer NOT NULL,
	"quantity" double precision NOT NULL,
	CONSTRAINT "stock_settlement_id_resource_id_pk" PRIMARY KEY("settlement_id","resource_id"),
	CONSTRAINT "stock_non_negative" CHECK ("stock"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "building_cost" ADD CONSTRAINT "building_cost_building_type_id_building_type_id_fk" FOREIGN KEY ("building_type_id") REFERENCES "public"."building_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "building_cost" ADD CONSTRAINT "building_cost_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_settlement_id_settlement_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;