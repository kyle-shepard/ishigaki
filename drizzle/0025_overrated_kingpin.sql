CREATE TABLE "recipe_input" (
	"building_type_id" integer NOT NULL,
	"resource_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "recipe_input_building_type_id_resource_id_pk" PRIMARY KEY("building_type_id","resource_id"),
	CONSTRAINT "recipe_input_positive" CHECK ("recipe_input"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "operation" DROP CONSTRAINT "operation_build_is_complete";--> statement-breakpoint
ALTER TABLE "building_type" ADD COLUMN "produces_resource_id" integer;--> statement-breakpoint
ALTER TABLE "building_type" ADD COLUMN "output_quantity" integer;--> statement-breakpoint
ALTER TABLE "building_type" ADD COLUMN "craft_seconds" integer;--> statement-breakpoint
ALTER TABLE "recipe_input" ADD CONSTRAINT "recipe_input_building_type_id_building_type_id_fk" FOREIGN KEY ("building_type_id") REFERENCES "public"."building_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_input" ADD CONSTRAINT "recipe_input_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "building_type" ADD CONSTRAINT "building_type_produces_resource_id_resource_id_fk" FOREIGN KEY ("produces_resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "building_type" ADD CONSTRAINT "building_type_recipe" CHECK (("building_type"."produces_resource_id" IS NULL AND "building_type"."output_quantity" IS NULL AND "building_type"."craft_seconds" IS NULL)
			 OR ("building_type"."produces_resource_id" IS NOT NULL AND "building_type"."output_quantity" IS NOT NULL AND "building_type"."craft_seconds" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "building_type" ADD CONSTRAINT "building_type_output_positive" CHECK ("building_type"."output_quantity" IS NULL OR "building_type"."output_quantity" > 0);--> statement-breakpoint
ALTER TABLE "building_type" ADD CONSTRAINT "building_type_craft_positive" CHECK ("building_type"."craft_seconds" IS NULL OR "building_type"."craft_seconds" > 0);--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_build_is_complete" CHECK ("operation"."type" NOT IN ('build', 'craft') OR "operation"."status" = 'queued' OR ("operation"."building_type_id" IS NOT NULL AND "operation"."complete_at" IS NOT NULL));