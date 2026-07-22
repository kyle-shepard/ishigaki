CREATE TABLE "tile_stock" (
	"player_id" integer NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"quantity" double precision NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	CONSTRAINT "tile_stock_player_id_x_y_pk" PRIMARY KEY("player_id","x","y"),
	CONSTRAINT "tile_stock_non_negative" CHECK ("tile_stock"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "terrain_type" ADD COLUMN "regrow_seconds" integer;--> statement-breakpoint
ALTER TABLE "tile_stock" ADD CONSTRAINT "tile_stock_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tile_stock" ADD CONSTRAINT "tile_stock_x_y_tile_x_y_fk" FOREIGN KEY ("x","y") REFERENCES "public"."tile"("x","y") ON DELETE no action ON UPDATE no action;