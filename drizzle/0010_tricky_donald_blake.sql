ALTER TABLE "building_type" ADD CONSTRAINT "building_type_display_name_unique" UNIQUE("display_name");--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_display_name_unique" UNIQUE("display_name");--> statement-breakpoint
ALTER TABLE "terrain_type" ADD CONSTRAINT "terrain_type_display_name_unique" UNIQUE("display_name");