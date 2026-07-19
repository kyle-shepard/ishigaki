CREATE TABLE "health_check" (
	"id" serial PRIMARY KEY NOT NULL,
	"note" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "health_check" ("note") VALUES ('scaffold ok');
