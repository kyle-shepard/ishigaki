CREATE TABLE "resource" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terrain_type" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"color" text NOT NULL,
	"buildable" boolean NOT NULL,
	"movement_cost" real NOT NULL,
	"yields_resource_id" integer
);
--> statement-breakpoint
CREATE TABLE "tile" (
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"terrain_type_id" integer NOT NULL,
	"quantity" integer,
	CONSTRAINT "tile_x_y_pk" PRIMARY KEY("x","y")
);
--> statement-breakpoint
ALTER TABLE "terrain_type" ADD CONSTRAINT "terrain_type_yields_resource_id_resource_id_fk" FOREIGN KEY ("yields_resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tile" ADD CONSTRAINT "tile_terrain_type_id_terrain_type_id_fk" FOREIGN KEY ("terrain_type_id") REFERENCES "public"."terrain_type"("id") ON DELETE no action ON UPDATE no action;