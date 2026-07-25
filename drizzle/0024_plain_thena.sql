ALTER TABLE "building" ADD COLUMN "road_mask" integer;--> statement-breakpoint
ALTER TABLE "building_type" ADD COLUMN "movement_cost" real;--> statement-breakpoint
ALTER TABLE "building" ADD CONSTRAINT "building_road_mask_range" CHECK ("building"."road_mask" IS NULL OR "building"."road_mask" BETWEEN 0 AND 15);