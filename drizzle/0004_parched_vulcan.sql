CREATE TABLE "profile" (
	"id" text PRIMARY KEY NOT NULL,
	"base_country" text NOT NULL,
	"relocation" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
