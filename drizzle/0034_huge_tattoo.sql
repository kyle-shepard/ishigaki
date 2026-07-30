ALTER TABLE "start_position" DROP CONSTRAINT "start_position_x_range";--> statement-breakpoint
ALTER TABLE "start_position" DROP CONSTRAINT "start_position_y_range";--> statement-breakpoint
ALTER TABLE "start_position" ADD CONSTRAINT "start_position_x_range" CHECK ("start_position"."x" >= 0 AND "start_position"."x" < 6912);--> statement-breakpoint
ALTER TABLE "start_position" ADD CONSTRAINT "start_position_y_range" CHECK ("start_position"."y" >= 0 AND "start_position"."y" < 6912);